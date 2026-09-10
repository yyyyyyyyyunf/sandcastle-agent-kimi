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

Empirical probing established what a session consists of and what resume
requires (originally pinned to kimi 0.27.0, re-pinned to 0.42.0 after the
CLI drifted — see below):

- a session is a directory
  `$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/` containing
  `state.json` + `agents/*/wire.jsonl` (+ `upcoming-goals.json` when the
  session has pending goals);
- `workDirKey = wd_<slug(basename)>_<sha256(realpath(cwd))[0:12]>`;
- resume-by-id is gated on FOUR things (kimi 0.42.0): the session dir lives
  under the current cwd's bucket; `state.json`'s **`cwd`** field equals the
  cwd realpath (0.42 reads `cwd` — the `workDir` field we rewrote for 0.27
  is now ignored); every wire's `runtime.set_binding` record carries
  `workspaceId` equal to the bucket key; and an entry for the id exists in
  `session_index.jsonl`;
- `state.json` carries an optional `forkedFrom` field — the CLI's own fork
  metadata — so a hand-rolled fork is indistinguishable from a native one.

## Decision

Implement fork at the storage layer, inside `buildPrintCommand`. When
`resumeSession` and `forkSession` are both set, the provider emits a
composite shell command:

1. the ensure-local relocate script (ADR 0002) — a no-op when the session
   is already local to the command's cwd;
2. a self-contained `node -e` script (node is guaranteed in the sandbox by
   the npm-installed kimi CLI) that
   - computes the cwd's bucket,
   - copies the parent's session directory to a fresh
     `session_<uuid>` id generated host-side,
   - removes `upcoming-goals.json` from the copy (native `/fork` does not
     carry goals over; plain resume DOES keep them),
   - rewrites the copy's `state.json` (`cwd`, every agent's `homedir`,
     fresh timestamps) and stamps `forkedFrom = <parentId>` — the copy
     inherits the parent's already-rebound wire records, so no binding
     rewrite is needed here,
   - appends the fork's entry to `session_index.jsonl`;
3. then `kimi -p <prompt> --output-format stream-json -m <model>
   --session <newId>` resumes the copy.

The stream's terminal `session.resume_hint` meta event reports the new id,
so Sandcastle's per-iteration capture lands on the fork and
`RunResult.resume()`/`fork()` compose normally afterwards.

Because the kimi CLI also gates plain resume on all four conditions, the
transfer hooks apply the same rewrites: `captureToHost` and
`resumeIntoSandbox` repoint `state.json` (`cwd` + all agent homedirs),
rebind every wire's `runtime.set_binding`, and upsert the destination
`session_index.jsonl` (host side: serialized by a mkdir lock, written
tmp+rename — concurrent captures must neither lose entries nor corrupt the
file).

## Consequences

- `RunResult.fork()` works for kimi with full parent immutability, verified
  live (`scripts/verify-host.mts`: parent `state.json` byte-identical after
  fork, fork recalls context, `forkedFrom` stamped, cross-cwd fork works).
- The mechanism depends on kimi's on-disk layout and index/registry
  behaviour, which are undocumented and HAVE already changed once (0.27 →
  0.42 replaced the `workDir` state field with `cwd` and added the
  `runtime.set_binding` gate, silently breaking the old rewrite).
  `verify-host` — including its cross-cwd cases — is the tripwire; the
  layout facts are pinned against 0.42.0, and the provider warns when the
  host CLI is older than the verified floor.
- The fork script assumes node on `PATH` inside the sandbox and a
  POSIX-shaped home directory — already true for the supported sandbox
  images.
- Sessions forked this way are valid for the interactive TUI as well
  (`/sessions` lists them), since the record is format-identical to a
  native fork.
