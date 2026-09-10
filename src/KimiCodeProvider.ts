import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type {
  AgentProvider,
  BindMountSandboxHandle,
  IterationUsage,
} from "@ai-hero/sandcastle";
import {
  buildKimiEnsureLocalScript,
  buildKimiForkScript,
  defaultHostSessionsDir,
  findKimiSessionOnHost,
  KIMI_MAIN_WIRE_REL,
  KIMI_SESSION_INDEX_FILE,
  KIMI_STATE_REL,
  KIMI_UPCOMING_GOALS_REL,
  kimiSessionDir,
  kimiWorkDirKey,
  kimiWorkDirKeyForRealPath,
  parseKimiUsageFromWire,
  rewriteKimiStateJson,
  rewriteKimiWireBinding,
  upsertKimiSessionIndex,
} from "./KimiSessionStore.js";

// AgentSessionStorage and ParsedStreamEvent are part of the public
// AgentProvider interface but not re-exported from @ai-hero/sandcastle —
// derive them structurally.
type AgentSessionStorage = NonNullable<AgentProvider["sessionStorage"]>;
type ParsedStreamEvent = ReturnType<AgentProvider["parseStreamLine"]>[number];

const shellEscape = (s: string): string =>
  "'" + s.replace(/'/g, "'\\''") + "'";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Extract an error message from a parsed JSON error event. Handles
 * { error: "string" }, { error: { message } }, { error: { data: { message } } },
 * and { message: "string" }.
 */
const extractErrorMessage = (obj: Record<string, unknown>): string | undefined => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; data?: { message?: unknown } };
    if (typeof e.message === "string") return e.message;
    if (typeof e.data?.message === "string") return e.data.message;
  }
  if (typeof obj.message === "string") return obj.message;
  return undefined;
};

/**
 * Kimi Code print mode passes the prompt as the `-p` argv argument; stdin is
 * not read (verified against kimi 0.27.0). Linux enforces a per-argument
 * limit (~128 KiB, ARG_MAX stack). Stay slightly under so users get a clear
 * error instead of spawn E2BIG. Mirrors Sandcastle's Cursor/Copilot guards.
 */
const KIMI_PRINT_PROMPT_MAX_BYTES = 120 * 1024;

function assertKimiPrintPromptFitsArgv(prompt: string): void {
  const n = Buffer.byteLength(prompt, "utf8");
  if (n > KIMI_PRINT_PROMPT_MAX_BYTES) {
    throw new Error(
      `Kimi print-mode prompt is ${n} bytes (max ${KIMI_PRINT_PROMPT_MAX_BYTES} bytes). The kimi CLI accepts the prompt only as a command-line argument; shorten the prompt or split the work.`,
    );
  }
}

/**
 * The on-disk session layout this provider's transfer layer speaks was
 * re-pinned to kimi 0.42.0 (schema v2: state.json `cwd`, wire
 * `runtime.set_binding`). Older CLIs are known-incompatible. The host CLI
 * is probed lazily on the first resume/fork command; in sandbox mode the
 * image's kimi is the image author's responsibility (see README).
 */
const KIMI_LAYOUT_MIN_VERSION = "0.42.0";

/** False only when the version string parses confidently below the floor. */
export const isKimiVersionLayoutSupported = (version: string): boolean => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 42;
};

/** Maps allowlisted kimi tool names to the input field with the display arg. */
const KIMI_TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  FetchURL: "url",
  Agent: "description",
};

/** kimi may emit content as a plain string or as content blocks; collapse
 *  blocks defensively (only string text is observed in practice). */
const contentText = (content: unknown): string | undefined => {
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const t = (block as { text?: unknown }).text;
          if (typeof t === "string") return t;
        }
        return "";
      })
      .join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
};

/**
 * Parse one line of `kimi -p ... --output-format stream-json` output.
 *
 * Schema (observed via kimi 0.42.0):
 *
 * - `{"role":"assistant","content":"..."}` — a complete assistant message
 *   (no deltas in print mode). Mapped to `text` + `result` (last result wins
 *   in the Orchestrator, so the final message ends up surfaced).
 * - `{"role":"assistant","tool_calls":[{"type":"function","id","function":
 *   {"name","arguments"}}]}` — tool calls; `arguments` is a JSON string.
 *   Mapped to `tool_call` events (allowlisted display arg, JSON fallback).
 * - `{"role":"tool","tool_call_id","content"}` — tool output. Skipped.
 * - `{"role":"meta","type":"session.resume_hint","session_id"}` — terminal
 *   event carrying the session id. Mapped to `session_id`.
 * - Errors go to stderr with a non-zero exit code; the `error` /
 *   `agent_error` branch is defensive only (mirrors other providers).
 */
const parseKimiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line) as {
      role?: string;
      type?: string;
      content?: unknown;
      session_id?: unknown;
      tool_calls?: unknown;
    };

    if (
      obj.role === "meta" &&
      obj.type === "session.resume_hint" &&
      typeof obj.session_id === "string"
    ) {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }

    if (obj.role === "assistant") {
      const events: ParsedStreamEvent[] = [];
      if (Array.isArray(obj.tool_calls)) {
        for (const call of obj.tool_calls as {
          function?: { name?: unknown; arguments?: unknown };
        }[]) {
          const fn = call?.function;
          if (typeof fn?.name !== "string") continue;
          const name = fn.name;
          const raw = fn.arguments;
          let args = "";
          if (typeof raw === "string" && raw.length > 0) {
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const field = KIMI_TOOL_ARG_FIELDS[name];
              const value = field !== undefined ? parsed[field] : undefined;
              args =
                typeof value === "string" ? value : JSON.stringify(parsed);
            } catch {
              args = raw;
            }
          }
          events.push({ type: "tool_call", name, args });
        }
      }
      const text = contentText(obj.content);
      if (text !== undefined) {
        events.push({ type: "text", text }, { type: "result", result: text });
      }
      return events;
    }

    if (obj.type === "error" || obj.type === "agent_error") {
      const msg = extractErrorMessage(obj as Record<string, unknown>);
      return msg ? [{ type: "result", result: msg }] : [];
    }

    // role:"tool" and anything else → skip.
    return [];
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

const readSandboxFile = async (
  handle: Pick<BindMountSandboxHandle, "copyFileOut">,
  sandboxPath: string,
  tag: string,
): Promise<string> => {
  const tmpPath = join(
    tmpdir(),
    `sandcastle-kimi-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await handle.copyFileOut(sandboxPath, tmpPath);
  try {
    return await readFile(tmpPath, "utf-8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
};

const writeSandboxFile = async (
  handle: Pick<BindMountSandboxHandle, "copyFileIn" | "exec">,
  sandboxPath: string,
  content: string,
  tag: string,
): Promise<void> => {
  const tmpPath = join(
    tmpdir(),
    `sandcastle-kimi-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(tmpPath, content);
  try {
    await handle.exec(`mkdir -p ${JSON.stringify(posix.dirname(sandboxPath))}`);
    await handle.copyFileIn(tmpPath, sandboxPath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
};

/** Resolve the cwd inside the sandbox — kimi hashes the real path. */
const realpathInSandbox = async (
  handle: Pick<BindMountSandboxHandle, "exec">,
  sandboxCwd: string,
): Promise<string> => {
  const result = await handle.exec(`realpath ${JSON.stringify(sandboxCwd)}`);
  const resolved = result.stdout.trim();
  return resolved.length > 0 ? resolved : sandboxCwd;
};

/** The files that make up a kimi session record, as session-dir-relative
 *  posix paths: `state.json`, every `agents/**\/wire.jsonl`, and
 *  `upcoming-goals.json` (pending goals survive capture/resume; only forks
 *  drop them — see docs/adr/0001). */
const isSessionRecordFile = (rel: string): boolean =>
  rel === KIMI_STATE_REL ||
  rel === KIMI_UPCOMING_GOALS_REL ||
  /^agents\/.+\/wire\.jsonl$/.test(rel);

const listHostSessionFiles = async (hostDir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else if (isSessionRecordFile(rel)) {
        out.push(rel);
      }
    }
  };
  await walk(hostDir, "");
  return out;
};

/** Atomic, cross-process-locked read-modify-write of a session_index.jsonl.
 *  A mkdir mutex serialises concurrent captures (mkdir is atomic), and the
 *  write itself is tmp+rename so a crash mid-write cannot corrupt the
 *  index. Best-effort: if the lock cannot be acquired in time (e.g. a stale
 *  lock from a crashed writer) we proceed unlocked rather than fail the
 *  capture. */
const upsertIndexFileAtomic = async (
  indexPath: string,
  entry: Parameters<typeof upsertKimiSessionIndex>[1],
): Promise<void> => {
  const dir = dirname(indexPath);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, `.${KIMI_SESSION_INDEX_FILE}.lock`);
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockPath);
      locked = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    const existing = await readFile(indexPath, "utf-8").catch(() => "");
    const tmpPath = join(
      dir,
      `.${KIMI_SESSION_INDEX_FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(tmpPath, upsertKimiSessionIndex(existing, entry));
    await rename(tmpPath, indexPath);
  } finally {
    if (locked) await rm(lockPath, { recursive: true, force: true });
  }
};

/** Options for the kimi-code agent provider. */
export interface KimiCodeOptions {
  /** Environment variables injected by this agent provider. This is where
   *  `KIMI_MODEL_NAME` / `KIMI_MODEL_API_KEY` (+ optional
   *  `KIMI_MODEL_BASE_URL` / `KIMI_MODEL_PROVIDER_TYPE`) go — kimi
   *  synthesises an in-memory provider from them, so the sandbox needs no
   *  config.toml. Pair with model `"__kimi_env_model__"`. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override kimi session directories for tests or non-standard installs.
   *  `sandboxSessionsDir` defaults to `<KIMI_CODE_HOME>/sessions` when
   *  `env.KIMI_CODE_HOME` is set, else `/home/agent/.kimi-code/sessions`. */
  readonly sessionStorage?: {
    readonly hostSessionsDir?: string;
    readonly sandboxSessionsDir?: string;
  };
}

const makeKimiSessionStorage = (
  options?: KimiCodeOptions,
): AgentSessionStorage => {
  const hostRoot = () =>
    options?.sessionStorage?.hostSessionsDir ?? defaultHostSessionsDir();
  const sandboxRoot = () =>
    options?.sessionStorage?.sandboxSessionsDir ??
    (options?.env?.KIMI_CODE_HOME !== undefined
      ? posix.join(options.env.KIMI_CODE_HOME, "sessions")
      : posix.join("/home/agent", ".kimi-code", "sessions"));

  const hostDirFor = (cwd: string, id: string): string =>
    kimiSessionDir(hostRoot(), kimiWorkDirKey(cwd), id);

  const sandboxDirFor = async (
    handle: Pick<BindMountSandboxHandle, "exec">,
    sandboxCwd: string,
    id: string,
  ): Promise<{ dir: string; realCwd: string }> => {
    const realCwd = await realpathInSandbox(handle, sandboxCwd);
    return {
      dir: posix.join(sandboxRoot(), kimiWorkDirKeyForRealPath(realCwd), id),
      realCwd,
    };
  };

  return {
    hostSessionFilePath: (cwd, id) =>
      join(hostDirFor(cwd, id), KIMI_MAIN_WIRE_REL),
    existsOnHost: async (cwd, id) =>
      (await fileExists(join(hostDirFor(cwd, id), KIMI_STATE_REL))) &&
      (await fileExists(join(hostDirFor(cwd, id), KIMI_MAIN_WIRE_REL))),
    readHostSession: async (cwd, id) => {
      const path = join(hostDirFor(cwd, id), KIMI_MAIN_WIRE_REL);
      if (!(await fileExists(path))) return undefined;
      return readFile(path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const { dir: sandboxDir } = await sandboxDirFor(
        handle,
        sandboxCwd,
        sessionId,
      );
      const hostDir = hostDirFor(hostCwd, sessionId);
      const hostRealCwd = realpathSync(hostCwd);
      const hostBucket = kimiWorkDirKeyForRealPath(hostRealCwd);
      const found = await handle.exec(
        `find ${JSON.stringify(sandboxDir)} -type f`,
      );
      const files = found.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((abs) => posix.relative(sandboxDir, abs))
        .filter(isSessionRecordFile);

      for (const required of [KIMI_STATE_REL, KIMI_MAIN_WIRE_REL]) {
        if (!files.includes(required)) {
          throw new Error(
            `sandcastle-agent-kimi: kimi session ${sessionId} is missing ${required} in the sandbox (looked in ${sandboxDir})`,
          );
        }
      }

      // Main session files are fatal; subagent wire files are best-effort
      // (mirrors Sandcastle's Claude subagent capture).
      const isMain = (rel: string): boolean =>
        rel === KIMI_STATE_REL || rel === KIMI_MAIN_WIRE_REL;

      for (const rel of files) {
        try {
          const content = await readSandboxFile(
            handle,
            posix.join(sandboxDir, rel),
            "kimi-cap",
          );
          const rewritten =
            rel === KIMI_STATE_REL
              ? rewriteKimiStateJson(content, {
                  workDir: hostRealCwd,
                  sessionDir: hostDir,
                })
              : rel.endsWith("/wire.jsonl")
                ? rewriteKimiWireBinding(content, hostBucket)
                : content;
          const dest = join(hostDir, rel);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, rewritten);
        } catch (err) {
          if (isMain(rel)) throw err;
          console.error(
            `sandcastle-agent-kimi: failed to capture kimi session file ${rel}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Register the session in the host index — `kimi --session <id>` is
      // gated on session_index.jsonl, not just the bucket dir.
      await upsertIndexFileAtomic(
        join(dirname(hostRoot()), KIMI_SESSION_INDEX_FILE),
        {
          sessionId,
          sessionDir: hostDir,
          workDir: hostRealCwd,
        },
      );
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const hostDir = hostDirFor(hostCwd, sessionId);
      const { dir: sandboxDir, realCwd } = await sandboxDirFor(
        handle,
        sandboxCwd,
        sessionId,
      );
      const sandboxBucket = kimiWorkDirKeyForRealPath(realCwd);
      const files = await listHostSessionFiles(hostDir);
      if (
        !files.includes(KIMI_STATE_REL) ||
        !files.includes(KIMI_MAIN_WIRE_REL)
      ) {
        throw new Error(
          `sandcastle-agent-kimi: kimi session ${sessionId} not found on the host (looked in ${hostDir})`,
        );
      }
      for (const rel of files) {
        const content = await readFile(join(hostDir, rel), "utf-8");
        const rewritten =
          rel === KIMI_STATE_REL
            ? rewriteKimiStateJson(content, {
                workDir: realCwd,
                sessionDir: sandboxDir,
              })
            : rel.endsWith("/wire.jsonl")
              ? rewriteKimiWireBinding(content, sandboxBucket)
              : content;
        await writeSandboxFile(
          handle,
          posix.join(sandboxDir, rel),
          rewritten,
          "kimi-res",
        );
      }

      // Register the session in the sandbox index (same gating as on the host).
      const sandboxIndexPath = posix.join(
        posix.dirname(sandboxRoot()),
        KIMI_SESSION_INDEX_FILE,
      );
      const existingIndex = await readSandboxFile(
        handle,
        sandboxIndexPath,
        "kimi-idx",
      ).catch(() => "");
      await writeSandboxFile(
        handle,
        sandboxIndexPath,
        upsertKimiSessionIndex(existingIndex, {
          sessionId,
          sessionDir: sandboxDir,
          workDir: realCwd,
        }),
        "kimi-idx",
      );
    },
    findByIdOnHost: (id) => findKimiSessionOnHost(id, hostRoot()),
  };
};

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export const kimiCode = (
  model: string,
  options?: KimiCodeOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => {
  let hostVersionChecked = false;
  const warnIfHostKimiTooOld = (): void => {
    if (hostVersionChecked) return;
    hostVersionChecked = true;
    try {
      const out = execFileSync("kimi", ["--version"], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (!isKimiVersionLayoutSupported(out)) {
        console.error(
          `sandcastle-agent-kimi: host kimi CLI ${out} is older than the verified layout floor ${KIMI_LAYOUT_MIN_VERSION} — session resume/fork transfers may break. Upgrade the kimi CLI.`,
        );
      }
    } catch {
      // kimi not on PATH (or slow) — the print command will surface that.
    }
  };

  return {
    name: "kimi-code",
    env: options?.env ?? {},
    captureSessions: options?.captureSessions ?? true,
    sessionStorage: makeKimiSessionStorage(options),

    buildPrintCommand({ prompt, resumeSession, forkSession }) {
      assertKimiPrintPromptFitsArgv(prompt);
      // `kimi -p` runs tool calls under the auto permission policy by design —
      // there is no bypass flag, so dangerouslySkipPermissions is not threaded
      // through (and --yolo/--auto are rejected in print mode anyway).
      const base = `kimi -p ${shellEscape(prompt)} --output-format stream-json -m ${shellEscape(model)}`;
      if (resumeSession) {
        warnIfHostKimiTooOld();
        // Make the session resumable from the cwd this command will run in.
        // No-ops when the transfer hooks already placed it (sandbox mode);
        // relocates it between host buckets in no-sandbox mode, where
        // merge-to-head gives every run a fresh worktree path.
        const ensure = `node -e ${shellEscape(buildKimiEnsureLocalScript(resumeSession))}`;
        if (forkSession) {
          // The kimi CLI has no fork flag, so fork at the storage layer:
          // copy the (now local) session dir under a fresh id and resume the
          // copy. The stream's resume_hint reports the new id, so capture
          // lands on the fork. See docs/adr/0001.
          const newId = `session_${randomUUID()}`;
          return {
            command: `${ensure} && node -e ${shellEscape(buildKimiForkScript(resumeSession, newId))} && ${base} --session ${shellEscape(newId)}`,
          };
        }
        return {
          command: `${ensure} && ${base} --session ${shellEscape(resumeSession)}`,
        };
      }
      return { command: base };
    },

    parseStreamLine(line: string): ParsedStreamEvent[] {
      return parseKimiStreamLine(line);
    },

    parseSessionUsage(content: string): IterationUsage | undefined {
      return parseKimiUsageFromWire(content);
    },
  };
};
