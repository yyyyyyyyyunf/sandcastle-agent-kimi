# AGENTS.md

Kimi Code CLI agent provider for Sandcastle — see README.md for what it does
and how it's consumed.

## Conventions

- **pnpm only.** `packageManager` is pinned; `npm install` here creates a
  stray lockfile that CI rejects.
- **Public API is `kimiCode` + `KimiCodeOptions`, deliberately.** Storage
  helpers and script builders stay internal (tests and scripts deep-import
  them). Treat any new export as a decision, not a drive-by.
- **Vocabulary lives in CONTEXT.md** — capture / resume / fork, workDir
  bucket, runtime binding. Use those terms; don't invent parallel ones.

## The kimi CLI contract (read this before touching transfer code)

Kimi's on-disk session layout is **undocumented and version-pinned**: every
fact in `src/KimiSessionStore.ts` comments and the pinned test vectors was
established by live probes against kimi 0.42.0, and the layout has already
silently changed once (state `workDir` → `cwd`, plus a 40-char bucket-slug
truncation). Rules of engagement:

- Touching session transfer, resume, or fork → read `docs/adr/0001` and
  `docs/adr/0002` first.
- Trust probes, not assumptions: when a layout question matters, run a tiny
  throwaway session against the real CLI and look at the files.
- Bump the pinned version by re-probing, not by editing the constant.

## Verification ladder

1. `pnpm run typecheck` + `pnpm test` — fast gates, always green on commit.
2. `pnpm verify-host` — live CLI tripwire (incl. cross-cwd relocation).
3. `pnpm e2e` — full `run()` matrix in throwaway git repos; docker legs need
   a running daemon (OrbStack).

The two live rungs write real (small, throwaway) sessions into your actual
`~/.kimi-code` — run them knowingly, and always after a kimi CLI upgrade.
