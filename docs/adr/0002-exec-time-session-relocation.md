# 0002. Exec-time session relocation for no-sandbox cwd churn

Sandcastle never invokes transfer hooks in no-sandbox mode (they are gated
on a bind-mount handle), yet `merge-to-head` gives every run — including
resume runs — a fresh worktree path, and kimi 0.42 refuses to resume a
session from any other directory. So in no-sandbox mode every
resume/fork under worktree churn failed at the CLI gate (reproduced
end-to-end: gate error on resume, `cpSync ENOENT` on fork). We relocate
the session at command-execution time instead of asking Sandcastle for a
hook.

## Context

The only interception point that has both the right timing and the right
information is the command string itself: it executes with the real,
already-created cwd, whereas `findByIdOnHost` (the no-sandbox precheck)
receives only the session id, and the upcoming merge-to-head worktree path
is not even decided yet at precheck time. This is the same pattern the fork
script already used (`process.cwd()` at exec time).

Alternatives considered: failing early with a clear error (honest but makes
resume unusable under the default AFK-batch workflow); asking Sandcastle
for a no-sandbox rewrite hook (right layer, wrong timeline); switching to
the named-`branch` strategy (deterministic worktree path, but breaks the
user's merge-to-head workflow).

## Decision

`buildPrintCommand` prepends a self-contained `node -e` **ensure-local**
script to every resume/fork command. The script:

1. computes the current cwd's bucket;
2. no-ops when the session's `state.json.cwd` already matches (the sandbox
   case, where the transfer hooks already placed it — so sandbox behaviour
   is unchanged);
3. otherwise locates the session (via `session_index.jsonl`, falling back
   to a bucket scan), copies it into the cwd's bucket, rewrites `state.json`
   (`cwd` + every agent's `homedir`), rebinds every wire's
   `runtime.set_binding` to the new bucket, upserts the index
   (tmp+rename), and only then removes the source dir.

## Consequences

- No-sandbox resume/fork survive worktree churn: verified live by
  `verify-host`'s cross-cwd cases and by the `sandcastle-kimi-e2e` matrix
  (nosandbox/merge-to-head RESUME + FORK flipped from FAIL to PASS).
- In no-sandbox mode the host session dir IS the live store, so relocation
  mutates the user's session in place (the old bucket copy is removed after
  a successful move). A failed relocate leaves the source untouched.
- Relocating also repairs sessions captured from sandboxes whose on-host
  `cwd` still points at `/home/agent/workspace` — host-side resume of a
  docker-captured session now works.
- Parallel resume/fork of the SAME session id across different cwds remains
  racy by nature (one session cannot live in two worktrees under kimi's
  model); the loser fails loudly with "session not found" instead of
  corrupting state. Distinct forks (fresh ids) are unaffected.
