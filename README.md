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

Requires the `kimi` CLI (verified against 0.27.0) wherever the agent runs —
on the host for no-sandbox runs, or in your sandbox image (see below).

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
(no-sandbox runs), but copying them into sandboxes is not recommended.

## Capabilities

| Capability | Status | Notes |
| --- | --- | --- |
| Non-interactive print mode | ✅ | `kimi -p <prompt> --output-format stream-json` |
| Permissions | ✅ | print mode auto-approves tool calls by design |
| Session capture + resume | ✅ | `RunResult.resume()` → `kimi --session <id>` |
| Session fork | ✅ | storage-layer copy — see [ADR 0001](docs/adr/0001-fork-via-storage-layer-copy.md) |
| Per-iteration token usage | ✅ | parsed from `usage.record` events in `wire.jsonl` |
| Interactive mode | ❌ | no `buildInteractiveArgs` (no documented prompt seeding) |
| Prompt via stdin | ❌ | argv only; prompts capped at 120 KB |

## How sessions work

Kimi Code stores sessions under
`$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/`, where
`workDirKey = wd_<slug(basename)>_<sha256(realpath(cwd))[0:12]>`. Each
session directory holds `state.json` (metadata) and
`agents/main/wire.jsonl` (the conversation record + usage events).

`kimi --session <id>` requires **two** things to line up:

1. `state.json`'s `workDir` must equal the current working directory
   (realpath-compared), and
2. the id must be registered in `$KIMI_CODE_HOME/session_index.jsonl`.

The provider's `sessionStorage` handles both on every transfer:
`captureToHost` / `resumeIntoSandbox` copy the session record (state.json +
all `agents/**/wire.jsonl`, subagents included), rewrite `state.json`'s
`workDir` / `agents.main.homedir` for the destination, and upsert the
destination's `session_index.jsonl`.

Session directory defaults: host `$KIMI_CODE_HOME/sessions` (or
`~/.kimi-code/sessions`), sandbox `/home/agent/.kimi-code/sessions`. If your
sandbox sets `KIMI_CODE_HOME`, point `sandboxSessionsDir` at
`<that home>/sessions`:

```ts
kimiCode("__kimi_env_model__", {
  env: { /* ... */, KIMI_CODE_HOME: "/home/agent/.kimi-code" },
  sessionStorage: { sandboxSessionsDir: "/home/agent/.kimi-code/sessions" },
});
```

## Sandbox image requirements

- `kimi` CLI installed (e.g. `npm i -g @moonshot-ai/kimi-code`, or the native
  installer from the Kimi Code docs; keep the `USER agent` /
  `ENTRYPOINT ["sleep", "infinity"]` structure from Sandcastle's own
  Dockerfiles).
- `node` available on `PATH` (true for npm-installed kimi). The fork path
  runs a small `node -e` script inside the sandbox.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/
npm run verify-host # live check against the real kimi CLI on this host
```

`verify-host` exercises fresh/resume/fork round-trips end to end using your
host kimi install and credentials (throwaway cwd; writes two small sessions
into your real `~/.kimi-code`, like normal CLI usage).

## Prior art / conventions

Mirrors Sandcastle's built-in providers (`src/AgentProvider.ts` in the
sandcastle repo): same factory shape, same `shellEscape` and argv-size
guard patterns, same best-effort subagent capture. `AgentSessionStorage` and
`ParsedStreamEvent` are not re-exported from `@ai-hero/sandcastle`, so this
package derives them structurally from the public `AgentProvider` interface.
