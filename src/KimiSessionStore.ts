/**
 * Kimi Code session storage primitives.
 *
 * Kimi Code persists every session under
 * `$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/` (default
 * `~/.kimi-code/sessions/`):
 *
 * - `state.json` — session metadata. Resume-by-id requires its `workDir`
 *   field to match the current working directory (realpath compared), so
 *   transfers between host and sandbox must rewrite it (plus
 *   `agents.main.homedir`, an absolute path inside the session dir).
 * - `agents/main/wire.jsonl` — the main agent's conversation record: resume
 *   source, replay log, and per-turn token usage (`usage.record` events).
 * - `agents/<subagentId>/wire.jsonl` — subagent records, when the agent
 *   spawned subagents.
 *
 * `session_index.jsonl` at the data root IS consulted for
 * `kimi --session <id>`: resume-by-id is gated on an index entry
 * (`{sessionId, sessionDir, workDir}`), so transfers and forks must
 * register the session on the destination side. (All verified empirically
 * against kimi 0.27.0.)
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HostSessionLookup, IterationUsage } from "@ai-hero/sandcastle";

export const KIMI_STATE_REL = "state.json";
export const KIMI_MAIN_WIRE_REL = "agents/main/wire.jsonl";
export const KIMI_SESSION_INDEX_FILE = "session_index.jsonl";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Default kimi data root, honouring KIMI_CODE_HOME. */
export const defaultKimiHome = (): string =>
  process.env.KIMI_CODE_HOME ?? join(process.env.HOME ?? "~", ".kimi-code");

export const defaultHostSessionsDir = (): string =>
  join(defaultKimiHome(), "sessions");

/**
 * Compute the bucket name kimi derives from a working directory:
 * `wd_<slug>_<first-12-hex-of-sha256(realpath)>`.
 *
 * Slug rule derived from empirical probes against kimi 0.27.0 (7 vectors):
 * basename lowercased, runs of chars outside `[a-z0-9._-]` collapsed to a
 * single `-`, leading/trailing `-` stripped. Exotic cases beyond those
 * vectors (e.g. names that slugify to empty) are unverified.
 */
export const kimiWorkDirKeyForRealPath = (real: string): string => {
  const slug = basename(real)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 12);
  return `wd_${slug}_${hash}`;
};

/** Like {@link kimiWorkDirKeyForRealPath} but resolves symlinks first
 *  (macOS `/tmp` → `/private/tmp` — kimi hashes the real path). */
export const kimiWorkDirKey = (cwd: string): string =>
  kimiWorkDirKeyForRealPath(realpathSync(cwd));

/** `<sessionsRoot>/<workDirKey>/<sessionId>/` (host path flavour). */
export const kimiSessionDir = (
  sessionsRoot: string,
  workDirKey: string,
  sessionId: string,
): string => join(sessionsRoot, workDirKey, sessionId);

export interface KimiStateRewrite {
  /** Absolute working directory the session should belong to (realpath). */
  readonly workDir: string;
  /** Absolute path of `<sessionDir>/agents/main` on the target side. */
  readonly agentHomedir: string;
  /** Set on forks: the parent session id. */
  readonly forkedFrom?: string;
}

/**
 * Rewrite a kimi `state.json` string for transfer between directories:
 * repoints `workDir` and `agents.main.homedir`, optionally stamps
 * `forkedFrom`. Pure string function — callers do their own file I/O.
 */
export const rewriteKimiStateJson = (
  stateJson: string,
  rewrite: KimiStateRewrite,
): string => {
  const state = JSON.parse(stateJson) as {
    workDir?: string;
    forkedFrom?: string;
    agents?: { main?: { homedir?: string } };
  };
  state.workDir = rewrite.workDir;
  if (state.agents?.main) {
    state.agents.main.homedir = rewrite.agentHomedir;
  }
  if (rewrite.forkedFrom !== undefined) {
    state.forkedFrom = rewrite.forkedFrom;
  }
  return JSON.stringify(state, null, 2);
};

/**
 * Extract per-iteration token usage from a wire.jsonl string: the LAST
 * `usage.record` event with `usageScope: "turn"`. Kimi's usage shape
 * `{ inputOther, output, inputCacheRead, inputCacheCreation }` maps onto
 * Sandcastle's Claude-shaped IterationUsage.
 */
export const parseKimiUsageFromWire = (
  wireJsonl: string,
): IterationUsage | undefined => {
  const lines = wireJsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{") || !line.includes('"usage.record"')) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        usageScope?: string;
        usage?: Record<string, unknown>;
      };
      if (obj.type !== "usage.record" || obj.usageScope !== "turn") continue;
      const u = obj.usage;
      if (
        typeof u?.inputOther !== "number" ||
        typeof u?.output !== "number" ||
        typeof u?.inputCacheRead !== "number" ||
        typeof u?.inputCacheCreation !== "number"
      ) {
        continue;
      }
      return {
        inputTokens: u.inputOther,
        cacheCreationInputTokens: u.inputCacheCreation,
        cacheReadInputTokens: u.inputCacheRead,
        outputTokens: u.output,
      };
    } catch {
      // Not valid JSON — keep scanning.
    }
  }
  return undefined;
};

/**
 * Locate a kimi session on the host by id, scanning every bucket under the
 * sessions root. Used by Sandcastle's no-sandbox resume precheck.
 */
export const findKimiSessionOnHost = async (
  id: string,
  sessionsDir?: string,
): Promise<HostSessionLookup> => {
  const root = sessionsDir ?? defaultHostSessionsDir();
  const entries = await readdir(root, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("wd_")) continue;
    const candidate = join(root, entry.name, id, KIMI_MAIN_WIRE_REL);
    if (await fileExists(candidate)) {
      return { path: candidate, searchedRoot: root };
    }
  }
  return { path: undefined, searchedRoot: root };
};

export interface KimiSessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

/**
 * Insert or replace a session's entry in a `session_index.jsonl` string.
 * kimi gates `kimi --session <id>` on this registry, so session transfers
 * and forks must upsert the destination index. Pure string function —
 * callers do their own file I/O. Malformed lines are preserved.
 */
export const upsertKimiSessionIndex = (
  indexJsonl: string,
  entry: KimiSessionIndexEntry,
): string => {
  const kept = indexJsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      try {
        return (
          (JSON.parse(line) as { sessionId?: unknown }).sessionId !==
          entry.sessionId
        );
      } catch {
        return true;
      }
    });
  kept.push(JSON.stringify(entry));
  return kept.join("\n") + "\n";
};

/**
 * Build the self-contained `node -e` script that forks a kimi session inside
 * the sandbox: copies `<sessions>/<bucket-of-cwd>/<parentId>` to `<newId>`,
 * repoints the copy's state.json at the current directory, stamps
 * `forkedFrom`, and registers the fork in `session_index.jsonl` (kimi gates
 * resume-by-id on the index). The parent directory is left byte-for-byte
 * unchanged (Sandcastle ADR-0018 fork semantics), which
 * `kimi --session <newId>` then resumes. Requires node in the sandbox —
 * guaranteed when kimi is installed via npm. Contains no single quotes so
 * it shell-escapes cleanly.
 */
export const buildKimiForkScript = (
  parentId: string,
  newId: string,
): string =>
  [
    'const fs=require("fs"),path=require("path"),crypto=require("crypto");',
    'const home=process.env.KIMI_CODE_HOME||path.join(process.env.HOME||"~",".kimi-code");',
    "const cwd=fs.realpathSync(process.cwd());",
    'const slug=path.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"");',
    'const key="wd_"+slug+"_"+crypto.createHash("sha256").update(cwd).digest("hex").slice(0,12);',
    "const dir=path.join(home,\"sessions\",key);",
    `const src=path.join(dir,${JSON.stringify(parentId)}),dst=path.join(dir,${JSON.stringify(newId)});`,
    "fs.cpSync(src,dst,{recursive:true});",
    'fs.rmSync(path.join(dst,"upcoming-goals.json"),{force:true});',
    'const sp=path.join(dst,"state.json");',
    'const s=JSON.parse(fs.readFileSync(sp,"utf8"));',
    "const now=new Date().toISOString();",
    `s.workDir=cwd;s.forkedFrom=${JSON.stringify(parentId)};s.createdAt=now;s.updatedAt=now;`,
    'if(s.agents&&s.agents.main)s.agents.main.homedir=path.join(dst,"agents","main");',
    "fs.writeFileSync(sp,JSON.stringify(s,null,2));",
    'fs.appendFileSync(path.join(home,"session_index.jsonl"),',
    `JSON.stringify({sessionId:${JSON.stringify(newId)},sessionDir:dst,workDir:cwd})+"\\n");`,
  ].join("");
