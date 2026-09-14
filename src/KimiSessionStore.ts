/**
 * Kimi Code session storage primitives.
 *
 * Kimi Code persists every session under
 * `$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/` (default
 * `~/.kimi-code/sessions/`), where `workDirKey` is derived from the
 * realpath of the session's working directory.
 *
 * Resume-by-id (`kimi --session <id>`) is gated on FOUR things lining up
 * (all verified empirically against kimi 0.42.0):
 *
 * 1. the session dir lives under the bucket of the current cwd's realpath;
 * 2. `state.json`'s `cwd` field equals that realpath (schema v2 — kimi
 *    ≤0.27 used a `workDir` field that 0.42 no longer reads);
 * 3. every `agents/<id>/wire.jsonl`'s `runtime.set_binding` record carries
 *    `workspaceId` equal to the current bucket key;
 * 4. `$KIMI_CODE_HOME/session_index.jsonl` has an entry
 *    `{sessionId, sessionDir, workDir}` for the id.
 *
 * Transfers between directories (host↔sandbox, or no-sandbox worktree
 * churn) must keep all four consistent — see relocateKimiSessionFiles and
 * the `node -e` scripts built below.
 *
 * Session files: `state.json` (metadata; `agents` is a map of agentId →
 * `{ homedir, ... }` with absolute paths into the session dir),
 * `agents/<id>/wire.jsonl` (conversation record + usage events),
 * `upcoming-goals.json` (pending goals, when present).
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HostSessionLookup, IterationUsage } from "@fly4ai/sandcastle";

export const KIMI_STATE_REL = "state.json";
export const KIMI_MAIN_WIRE_REL = "agents/main/wire.jsonl";
export const KIMI_UPCOMING_GOALS_REL = "upcoming-goals.json";
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
 * Slug rule derived from empirical probes (originally pinned to kimi
 * 0.27.0, re-confirmed against 0.42.0): basename lowercased, runs of chars
 * outside `[a-z0-9._-]` collapsed to a single `-`, leading/trailing `-`
 * stripped, then **truncated to 40 chars** (observed on 0.42.0 buckets:
 * `kimi-probe-with-a-very-long-directory-name-…` (65 chars) →
 * `wd_kimi-probe-with-a-very-long-directory-na_<hash>`). Exotic cases
 * beyond those vectors (e.g. names that slugify to empty, truncation
 * landing on a dash) are unverified.
 */
export const kimiWorkDirKeyForRealPath = (real: string): string => {
  const slug = basename(real)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
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
  /** Absolute path of the session dir on the target side. Every agent's
   *  `homedir` is repointed to `<sessionDir>/agents/<agentId>`. */
  readonly sessionDir: string;
  /** Set on forks: the parent session id. */
  readonly forkedFrom?: string;
}

/**
 * Rewrite a kimi `state.json` string for transfer between directories
 * (kimi 0.42 schema v2): repoints `cwd`, repoints every agent's `homedir`
 * (main and subagents alike), optionally stamps `forkedFrom`. Pure string
 * function — callers do their own file I/O.
 */
export const rewriteKimiStateJson = (
  stateJson: string,
  rewrite: KimiStateRewrite,
): string => {
  const state = JSON.parse(stateJson) as {
    cwd?: string;
    forkedFrom?: string;
    agents?: Record<string, { homedir?: string } | undefined>;
  };
  state.cwd = rewrite.workDir;
  if (state.agents) {
    for (const [agentId, agent] of Object.entries(state.agents)) {
      if (agent) agent.homedir = `${rewrite.sessionDir}/agents/${agentId}`;
    }
  }
  if (rewrite.forkedFrom !== undefined) {
    state.forkedFrom = rewrite.forkedFrom;
  }
  return JSON.stringify(state, null, 2);
};

/**
 * Rewrite the `runtime.set_binding` records in a wire.jsonl string so the
 * session binds to a different workDir bucket. kimi 0.42 refuses to resume
 * a session whose binding workspaceId does not match the bucket derived
 * from the current cwd. Non-binding lines are preserved byte-for-byte.
 */
export const rewriteKimiWireBinding = (
  wireJsonl: string,
  workspaceId: string,
): string => {
  if (!wireJsonl.includes('"runtime.set_binding"')) return wireJsonl;
  return wireJsonl
    .split("\n")
    .map((line) => {
      if (!line.includes('"runtime.set_binding"')) return line;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          workspaceId?: unknown;
        };
        if (
          obj.type === "runtime.set_binding" &&
          typeof obj.workspaceId === "string" &&
          obj.workspaceId !== workspaceId
        ) {
          return JSON.stringify({ ...obj, workspaceId });
        }
      } catch {
        // Not valid JSON — leave the line untouched.
      }
      return line;
    })
    .join("\n");
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
 * Build a self-contained `node -e` script that makes a kimi session
 * resumable from the CURRENT working directory: if the session's state
 * `cwd` does not already match, the session dir is relocated into the
 * bucket of the current cwd (found via `session_index.jsonl`, falling back
 * to a bucket scan), its `state.json` cwd and agent homedirs repointed,
 * every wire's `runtime.set_binding` rebound, and the index re-registered
 * (tmp+rename). The source dir is removed only after every rewrite
 * succeeds. Idempotent: a session already local to this cwd is a no-op.
 *
 * This is the no-sandbox self-heal step: in sandbox mode the transfer
 * hooks have already placed the session, so the script no-ops there.
 * Contains no single quotes so it shell-escapes cleanly.
 */
export const buildKimiEnsureLocalScript = (sessionId: string): string =>
  [
    'const fs=require("fs"),path=require("path"),crypto=require("crypto");',
    'const home=process.env.KIMI_CODE_HOME||path.join(process.env.HOME||"~",".kimi-code");',
    "const cwd=fs.realpathSync(process.cwd());",
    'const slug=path.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40);',
    'const key="wd_"+slug+"_"+crypto.createHash("sha256").update(cwd).digest("hex").slice(0,12);',
    'const root=path.join(home,"sessions");',
    `const sid=${JSON.stringify(sessionId)};`,
    'const dst=path.join(root,key,sid);',
    'const stateAt=(d)=>path.join(d,"state.json");',
    "let local=false;",
    "if(fs.existsSync(stateAt(dst))){try{local=JSON.parse(fs.readFileSync(stateAt(dst),\"utf8\")).cwd===cwd;}catch{}}",
    "if(!local){",
    'const idx=path.join(home,"session_index.jsonl");',
    "let src;",
    'if(fs.existsSync(idx)){for(const line of fs.readFileSync(idx,"utf8").split("\\n")){if(!line.trim())continue;try{const e=JSON.parse(line);if(e.sessionId===sid&&typeof e.sessionDir==="string"&&fs.existsSync(stateAt(e.sessionDir))){src=e.sessionDir;break;}}catch{}}}',
    'if(!src&&fs.existsSync(root)){for(const b of fs.readdirSync(root)){if(!b.startsWith("wd_"))continue;const c=path.join(root,b,sid);if(fs.existsSync(stateAt(c))){src=c;break;}}}',
    'if(!src){throw new Error("sandcastle-agent-kimi: kimi session "+sid+" not found under "+root);}',
    "if(src!==dst){",
    "fs.mkdirSync(path.dirname(dst),{recursive:true});",
    "fs.cpSync(src,dst,{recursive:true});",
    "}",
    "const sp=stateAt(dst);",
    'const s=JSON.parse(fs.readFileSync(sp,"utf8"));',
    "s.cwd=cwd;",
    'if(s.agents){for(const id of Object.keys(s.agents)){if(s.agents[id])s.agents[id].homedir=path.join(dst,"agents",id);}}',
    "fs.writeFileSync(sp,JSON.stringify(s,null,2));",
    'const adir=path.join(dst,"agents");',
    'if(fs.existsSync(adir)){for(const a of fs.readdirSync(adir)){const w=path.join(adir,a,"wire.jsonl");if(!fs.existsSync(w))continue;const lines=fs.readFileSync(w,"utf8").split("\\n");let changed=false;const out=lines.map((l)=>{if(l.indexOf("runtime.set_binding")===-1)return l;try{const o=JSON.parse(l);if(o.type==="runtime.set_binding"&&typeof o.workspaceId==="string"&&o.workspaceId!==key){o.workspaceId=key;changed=true;return JSON.stringify(o);}}catch{}return l;});if(changed)fs.writeFileSync(w,out.join("\\n"));}}',
    "let lines=[];",
    'if(fs.existsSync(idx))lines=fs.readFileSync(idx,"utf8").split("\\n").filter((l)=>l.trim());',
    "const kept=lines.filter((l)=>{try{return JSON.parse(l).sessionId!==sid;}catch{return true;}});",
    "kept.push(JSON.stringify({sessionId:sid,sessionDir:dst,workDir:cwd}));",
    'const tmp=idx+".tmp."+process.pid;',
    'fs.writeFileSync(tmp,kept.join("\\n")+"\\n");',
    "fs.renameSync(tmp,idx);",
    "if(src!==dst&&src.startsWith(root+path.sep)){fs.rmSync(src,{recursive:true,force:true});}",
    "}",
  ].join("");

/**
 * Build the self-contained `node -e` script that forks a kimi session:
 * copies `<sessions>/<bucket-of-cwd>/<parentId>` to `<newId>`, repoints the
 * copy's state.json (schema v2: `cwd` plus every agent's homedir), drops
 * the parent's pending goals (forks do not inherit them — ADR 0001),
 * stamps `forkedFrom`, and appends to `session_index.jsonl`. The parent
 * directory is left byte-for-byte unchanged (Sandcastle ADR-0018 fork
 * semantics), which `kimi --session <newId>` then resumes. The copy
 * inherits the parent's (already rebound) wire records, so the fork stays
 * bound to the current bucket. Requires node in the sandbox — guaranteed
 * when kimi is installed via npm. Contains no single quotes so it
 * shell-escapes cleanly.
 */
export const buildKimiForkScript = (
  parentId: string,
  newId: string,
): string =>
  [
    'const fs=require("fs"),path=require("path"),crypto=require("crypto");',
    'const home=process.env.KIMI_CODE_HOME||path.join(process.env.HOME||"~",".kimi-code");',
    "const cwd=fs.realpathSync(process.cwd());",
    'const slug=path.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40);',
    'const key="wd_"+slug+"_"+crypto.createHash("sha256").update(cwd).digest("hex").slice(0,12);',
    "const dir=path.join(home,\"sessions\",key);",
    `const src=path.join(dir,${JSON.stringify(parentId)}),dst=path.join(dir,${JSON.stringify(newId)});`,
    "fs.cpSync(src,dst,{recursive:true});",
    'fs.rmSync(path.join(dst,"upcoming-goals.json"),{force:true});',
    'const sp=path.join(dst,"state.json");',
    'const s=JSON.parse(fs.readFileSync(sp,"utf8"));',
    "const now=new Date().toISOString();",
    `s.cwd=cwd;s.forkedFrom=${JSON.stringify(parentId)};s.createdAt=now;s.updatedAt=now;`,
    'if(s.agents){for(const id of Object.keys(s.agents)){if(s.agents[id])s.agents[id].homedir=path.join(dst,"agents",id);}}',
    "fs.writeFileSync(sp,JSON.stringify(s,null,2));",
    'fs.appendFileSync(path.join(home,"session_index.jsonl"),',
    `JSON.stringify({sessionId:${JSON.stringify(newId)},sessionDir:dst,workDir:cwd})+"\\n");`,
  ].join("");
