# sandcastle-agent-kimi

A [Kimi Code](https://www.kimi.com/code/docs/en/) **agent provider** for
[Sandcastle](https://github.com/mattpocock/sandcastle) (`@ai-hero/sandcastle`),
implemented against Sandcastle's public `AgentProvider` interface. Lets
`run()` orchestrate the `kimi` CLI inside sandboxes — with session capture,
resume, fork, and per-iteration token usage.

## Install

```sh
npm install sandcastle-agent-kimi @ai-hero/sandcastle
```

Requires the `kimi` CLI **≥ 0.42.0** (verified against 0.42.0; the provider
warns when the host CLI is older) wherever the agent runs — on the host for
no-sandbox runs, or in your sandbox image (see below).

## Quick start

```ts
import { run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { kimiCode } from "sandcastle-agent-kimi";

const result = await run({
  agent: kimiCode("__kimi_env_model__", {
    env: {
      KIMI_MODEL_NAME: "kimi-for-coding",
      KIMI_MODEL_API_KEY: process.env.KIMI_API_KEY!,
      // optional: KIMI_MODEL_BASE_URL, KIMI_MODEL_PROVIDER_TYPE
    },
  }),
  sandbox: docker({ /* ... */ }),
  prompt: "Fix the failing test in src/foo.test.ts",
});
```

### Authentication and model selection

Kimi Code does **not** read API keys from ordinary shell environment
variables — but the `KIMI_MODEL_*` family is an explicit env channel that
synthesises an in-memory provider and model alias. The synthesised alias is
always `__kimi_env_model__`, and it takes priority over `default_model` in
`config.toml`. That makes it the clean way to authenticate inside a sandbox:
no `config.toml` to bake, credentials stay in env.

If you instead bake a `config.toml` into your sandbox image
(`[providers.<name>]` with an API key), pass your configured alias as the
model instead (e.g. `kimiCode("my-provider/my-model")`).

OAuth credentials from `~/.kimi-code/credentials/` also work on the host
(no-sandbox runs), but copying them into sandboxes is not recommended. If
you do bind-mount them into a container, the mount must be **writable** —
kimi refreshes its token via an atomic write inside `credentials/`, and a
read-only mount fails mid-run with `EROFS`.

## Capabilities

| Capability | Status | Notes |
| --- | --- | --- |
| Non-interactive print mode | ✅ | `kimi -p <prompt> --output-format stream-json` |
| Permissions | ✅ | print mode auto-approves tool calls by design |
| Session capture + resume | ✅ | `RunResult.resume()` → `kimi --session <id>`; survives worktree churn in no-sandbox mode ([ADR 0002](docs/adr/0002-exec-time-session-relocation.md)) |
| Session fork | ✅ | storage-layer copy — see [ADR 0001](docs/adr/0001-fork-via-storage-layer-copy.md) |
| Per-iteration token usage | ✅ | parsed from `usage.record` events in `wire.jsonl`; bind-mount runs only — Sandcastle never asks for usage in no-sandbox mode, and kimi's stream emits none |
| Interactive mode | ❌ | no `buildInteractiveArgs` (no documented prompt seeding) |
| Prompt via stdin | ❌ | argv only; prompts capped at 120 KB |

## How sessions work

Kimi Code stores sessions under
`$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/`, where
`workDirKey = wd_<slug(basename)>_<sha256(realpath(cwd))[0:12]>`. Each
session directory holds `state.json` (metadata), `agents/*/wire.jsonl`
(conversation records + usage events, subagents included), and
`upcoming-goals.json` when the session has pending goals.

`kimi --session <id>` (kimi 0.42.0) requires **four** things to line up:

1. the session dir lives under the bucket of the current cwd's realpath,
2. `state.json`'s `cwd` equals that realpath,
3. every wire's `runtime.set_binding` record carries `workspaceId` equal to
   the bucket key, and
4. the id is registered in `$KIMI_CODE_HOME/session_index.jsonl`.

The provider keeps all four consistent on every transfer:
`captureToHost` / `resumeIntoSandbox` copy the session record, rewrite
`state.json`'s `cwd` and every agent's `homedir`, rebind the wire records,
and upsert the destination index (host-side index writes are
mkdir-locked + tmp-rename atomic). In **no-sandbox mode** Sandcastle never
runs these hooks, so every resume/fork command instead starts with an
exec-time *ensure-local* script that relocates the session into the current
cwd's bucket when needed (a no-op when it's already local) — this is what
makes resume/fork work under `merge-to-head`, where every run gets a fresh
worktree path.

Pending goals (`upcoming-goals.json`) survive capture and resume; a **fork
does not inherit them** (matching kimi's native `/fork`), so the fork script
drops the file from the copy.

Session directory defaults: host `$KIMI_CODE_HOME/sessions` (or
`~/.kimi-code/sessions`); sandbox `<KIMI_CODE_HOME>/sessions` when you set
`env.KIMI_CODE_HOME`, else `/home/agent/.kimi-code/sessions`. Override
either side via `sessionStorage`:

```ts
kimiCode("__kimi_env_model__", {
  env: { /* ... */, KIMI_CODE_HOME: "/home/agent/.kimi-code" },
  // only needed for exotic layouts — env.KIMI_CODE_HOME is already honored:
  sessionStorage: { sandboxSessionsDir: "/home/agent/.kimi-code/sessions" },
});
```

## Sandbox image requirements

- `kimi` CLI **≥ 0.42.0** installed (e.g. `npm i -g
  @moonshot-ai/kimi-code`, or the native installer from the Kimi Code docs;
  keep the `USER agent` / `ENTRYPOINT ["sleep", "infinity"]` structure from
  Sandcastle's own Dockerfiles).
- `node` available on `PATH` (true for npm-installed kimi). The resume/fork
  paths run small `node -e` scripts inside the sandbox.

## Development

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest
pnpm run build       # tsdown → dist/ (JS + bundled d.ts)
pnpm run verify-host # live check against the real kimi CLI on this host
```

`verify-host` exercises fresh/resume/fork round-trips end to end using your
host kimi install and credentials (throwaway cwds; writes a few small
sessions into your real `~/.kimi-code`, like normal CLI usage), including
cross-cwd resume/fork relocation.

## Prior art / conventions

Mirrors Sandcastle's built-in providers (`src/AgentProvider.ts` in the
sandcastle repo): same factory shape, same `shellEscape` and argv-size
guard patterns, same best-effort subagent capture. `AgentSessionStorage` and
`ParsedStreamEvent` are not re-exported from `@ai-hero/sandcastle`, so this
package derives them structurally from the public `AgentProvider` interface.
