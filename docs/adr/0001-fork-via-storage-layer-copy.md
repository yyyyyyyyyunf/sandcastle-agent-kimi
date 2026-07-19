# 0001. Fork via storage-layer copy

Status: accepted

## Context

Sandcastle's `RunResult.fork()` forks an agent session: the parent record
stays byte-for-byte unchanged and the continuation runs under a fresh
session id (sandcastle ADR 0018). Built-in providers implement this through
the agent's native CLI flag (`claude --fork-session`, `codex exec fork`).

The Kimi Code CLI has **no fork flag**. `/fork` exists only as an
interactive TUI slash command; `kimi --session <id>` in print mode resumes
(and therefore mutates) the given session. Forking a kimi session through
the CLI surface alone is impossible.

Empirical probing (kimi 0.27.0) established what a session consists of and
what resume requires:

- a session is a directory
  `$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/` containing
  `state.json` + `agents/*/wire.jsonl`;
- `workDirKey = wd_<slug(basename)>_<sha256(realpath(cwd))[0:12]>`;
- resume-by-id requires `state.json.workDir` to match the cwd **and** an
  entry for the id in `session_index.jsonl`;
- `state.json` carries an optional `forkedFrom` field — the CLI's own fork
  metadata — so a hand-rolled fork is indistinguishable from a native one.

## Decision

Implement fork at the storage layer, inside `buildPrintCommand`. When
`resumeSession` and `forkSession` are both set, the provider emits a
composite shell command:

1. a self-contained `node -e` script (node is guaranteed in the sandbox by
   the npm-installed kimi CLI) that
   - computes the cwd's bucket,
   - copies the parent's session directory to a fresh
     `session_<uuid>` id generated host-side,
   - removes `upcoming-goals.json` from the copy (native `/fork` does not
     carry goals over),
   - rewrites the copy's `state.json` (`workDir`, `agents.main.homedir`,
     fresh timestamps) and stamps `forkedFrom = <parentId>`,
   - appends the fork's entry to `session_index.jsonl`;
2. then `kimi -p <prompt> --output-format stream-json -m <model>
   --session <newId>` resumes the copy.

The stream's terminal `session.resume_hint` meta event reports the new id,
so Sandcastle's per-iteration capture lands on the fork and
`RunResult.resume()`/`fork()` compose normally afterwards.

Because the kimi CLI also gates plain resume on `session_index.jsonl`, the
same registration is applied in `captureToHost` (host index) and
`resumeIntoSandbox` (sandbox index) as an idempotent upsert.

## Consequences

- `RunResult.fork()` works for kimi with full parent immutability, verified
  live (`scripts/verify-host.mts`: parent `state.json` byte-identical after
  fork, fork recalls context, `forkedFrom` stamped).
- The mechanism depends on kimi's on-disk layout and index/registry
  behaviour, which are undocumented and could change in a future CLI
  release. `verify-host` is the tripwire; the layout facts were pinned
  against 0.27.0.
- The fork script assumes node on `PATH` inside the sandbox and a
  POSIX-shaped home directory — already true for the supported sandbox
  images.
- Sessions forked this way are valid for the interactive TUI as well
  (`/sessions` lists them), since the record is format-identical to a
  native fork.
