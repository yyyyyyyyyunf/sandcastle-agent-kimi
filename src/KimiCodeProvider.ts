import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type {
  AgentProvider,
  BindMountSandboxHandle,
  IterationUsage,
} from "@ai-hero/sandcastle";
import {
  buildKimiForkScript,
  defaultHostSessionsDir,
  findKimiSessionOnHost,
  KIMI_MAIN_WIRE_REL,
  KIMI_SESSION_INDEX_FILE,
  KIMI_STATE_REL,
  kimiSessionDir,
  kimiWorkDirKey,
  kimiWorkDirKeyForRealPath,
  parseKimiUsageFromWire,
  rewriteKimiStateJson,
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
    await readFile(path);
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
const extractErrorMessage = (obj: any): string | undefined => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    if (typeof err.message === "string") return err.message;
    if (typeof err.data?.message === "string") return err.data.message;
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

/** Maps allowlisted kimi tool names to the input field with the display arg. */
const KIMI_TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  FetchURL: "url",
  Agent: "description",
};

/**
 * Parse one line of `kimi -p ... --output-format stream-json` output.
 *
 * Schema (observed via kimi 0.27.0):
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
      if (typeof obj.content === "string" && obj.content.length > 0) {
        events.push(
          { type: "text", text: obj.content },
          { type: "result", result: obj.content },
        );
      }
      return events;
    }

    if (obj.type === "error" || obj.type === "agent_error") {
      const msg = extractErrorMessage(obj);
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
 *  posix paths: `state.json` plus every `agents/**\/wire.jsonl`. */
const isSessionRecordFile = (rel: string): boolean =>
  rel === KIMI_STATE_REL || (/^agents\/.+\/wire\.jsonl$/.test(rel) && rel !== "");

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
   *  When the sandbox runs with KIMI_CODE_HOME set, point
   *  `sandboxSessionsDir` at `<that home>/sessions`. */
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
    posix.join("/home/agent", ".kimi-code", "sessions");

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
    existsOnHost: (cwd, id) =>
      fileExists(join(hostDirFor(cwd, id), KIMI_STATE_REL)),
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
                  workDir: realpathSync(hostCwd),
                  agentHomedir: join(hostDir, "agents", "main"),
                })
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
      const indexPath = join(dirname(hostRoot()), KIMI_SESSION_INDEX_FILE);
      const existing = await readFile(indexPath, "utf-8").catch(() => "");
      await mkdir(dirname(indexPath), { recursive: true });
      await writeFile(
        indexPath,
        upsertKimiSessionIndex(existing, {
          sessionId,
          sessionDir: hostDir,
          workDir: realpathSync(hostCwd),
        }),
      );
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const hostDir = hostDirFor(hostCwd, sessionId);
      const { dir: sandboxDir, realCwd } = await sandboxDirFor(
        handle,
        sandboxCwd,
        sessionId,
      );
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
                agentHomedir: posix.join(sandboxDir, "agents", "main"),
              })
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
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => ({
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
    if (resumeSession && forkSession) {
      // The kimi CLI has no fork flag, so fork at the storage layer: copy
      // the (already transferred) session dir under a fresh id inside the
      // sandbox and resume the copy. The stream's resume_hint then reports
      // the new id, so capture lands on the fork. See docs/adr/0001.
      const newId = `session_${randomUUID()}`;
      return {
        command: `node -e ${shellEscape(buildKimiForkScript(resumeSession, newId))} && ${base} --session ${shellEscape(newId)}`,
      };
    }
    if (resumeSession) {
      return { command: `${base} --session ${shellEscape(resumeSession)}` };
    }
    return { command: base };
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseKimiStreamLine(line);
  },

  parseSessionUsage(content: string): IterationUsage | undefined {
    return parseKimiUsageFromWire(content);
  },
});
