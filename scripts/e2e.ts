/**
 * Live end-to-end matrix for the kimi provider against the real kimi CLI,
 * via Sandcastle's `run()` — unlike verify-host (which drives the provider's
 * commands directly), this exercises the full orchestration path:
 * branch strategies, worktree churn, capture, resume, fork.
 *
 * Each leg runs in a THROWAWAY git repo created under tmp (git init +
 * empty commit), so the harness never touches this repository's own git
 * state. Usage:
 *
 *   pnpm e2e                              # full matrix (5 legs)
 *   pnpm e2e nosandbox merge-to-head      # one leg
 *   pnpm e2e docker head                  # docker legs need the image;
 *                                         # it is auto-built on first use
 *
 * Requires: host kimi CLI ≥ 0.42.0 with OAuth credentials; for docker legs
 * a running docker daemon. Docker legs mount ~/.kimi-code/credentials
 * (writable — kimi token-refresh writes into it) and config.toml (ro).
 */

import { exec } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { run } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { kimiCode } from "../src/index.js";

const execp = promisify(exec);
const IMAGE = "sandcastle-kimi-e2e";

type Mode = "nosandbox" | "docker";
type Strategy = "head" | "branch" | "merge-to-head";
type RunResult = Awaited<ReturnType<typeof run>>;
type Iteration = RunResult["iterations"][number];

let failures = 0;
const pass = (tag: string, label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${tag} ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

const makeScratchRepo = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), "sak-e2e-repo-"));
  await execp("git init -b main -q", { cwd: repo });
  await execp(
    'git -c user.name=e2e -c user.email=e2e@local commit --allow-empty -qm init',
    { cwd: repo },
  );
  return repo;
};

const ensureDockerImage = async (): Promise<void> => {
  const present = await execp(`docker image inspect ${IMAGE}`).then(
    () => true,
    () => false,
  );
  if (present) return;
  console.log(`building ${IMAGE} (first docker leg)…`);
  await execp(
    `docker build -f scripts/e2e.Dockerfile -t ${IMAGE} .`,
    { maxBuffer: 16 * 1024 * 1024 },
  );
};

const attempt = async (
  tag: string,
  label: string,
  fn: () => Promise<RunResult>,
  judge: (it: Partial<Iteration>) => { ok: boolean; detail?: string },
): Promise<RunResult | undefined> => {
  try {
    const r = await fn();
    const it = r.iterations.at(-1) ?? {};
    const { ok, detail } = judge(it);
    pass(tag, label, ok, detail);
    return r;
  } catch (err) {
    pass(
      tag,
      label,
      false,
      String(err instanceof Error ? err.message : err).slice(0, 600),
    );
    return undefined;
  }
};

const runLeg = async (mode: Mode, strategy: Strategy): Promise<void> => {
  const tag = `${mode}/${strategy}`;
  const repo = await makeScratchRepo();
  const strategyObj =
    strategy === "head"
      ? ({ type: "head" } as const)
      : strategy === "branch"
        ? ({ type: "branch", branch: "e2e-named" } as const)
        : ({ type: "merge-to-head" } as const);
  const sandbox =
    mode === "docker"
      ? docker({
          imageName: IMAGE,
          mounts: [
            {
              hostPath: "~/.kimi-code/credentials",
              sandboxPath: "/home/agent/.kimi-code/credentials",
            },
            {
              hostPath: "~/.kimi-code/config.toml",
              sandboxPath: "/home/agent/.kimi-code/config.toml",
              readonly: true,
            },
          ],
        })
      : noSandbox();

  try {
    const fresh = await attempt(
      tag,
      "FRESH",
      () =>
        run({
          name: `e2e-${mode}-${strategy}`,
          agent: kimiCode("kimi-code/k3"),
          sandbox,
          cwd: repo,
          branchStrategy: strategyObj,
          prompt:
            "Create a file named marker.txt containing exactly the word PINEAPPLE, then stop.",
          maxIterations: 1,
        }),
      (it) => ({
        ok:
          typeof it.sessionId === "string" && it.sessionId.startsWith("session_"),
        detail: `sessionId=${it.sessionId}`,
      }),
    );

    const sid = fresh?.iterations.at(-1)?.sessionId;
    if (!fresh || !sid || !fresh.resume || !fresh.fork) {
      pass(tag, "ABORT", false, "no session id, or provider has no resume/fork");
      return;
    }
    const { resume, fork } = fresh;

    await attempt(
      tag,
      "RESUME",
      () =>
        resume(
          "Read the file marker.txt and reply with just the word it contains.",
        ),
      (it) => ({
        ok: it.sessionId === sid,
        detail: `sessionId=${it.sessionId}`,
      }),
    );

    await attempt(
      tag,
      "FORK",
      () =>
        fork(
          "Reply with just the word written in marker.txt.",
        ),
      (it) => ({
        ok: typeof it.sessionId === "string" && it.sessionId !== sid,
        detail: `sessionId=${it.sessionId}`,
      }),
    );
  } finally {
    if (failures === 0) {
      await rm(repo, { recursive: true, force: true });
    } else {
      console.log(`scratch repo kept for inspection: ${repo}`);
    }
  }
};

const main = async (): Promise<void> => {
  const [mode, strategy] = process.argv.slice(2);
  const legs: Array<[Mode, Strategy]> =
    mode && strategy
      ? [[mode as Mode, strategy as Strategy]]
      : [
          ["nosandbox", "head"],
          ["nosandbox", "branch"],
          ["nosandbox", "merge-to-head"],
          ["docker", "head"],
          ["docker", "merge-to-head"],
        ];
  if (legs.some(([m]) => m === "docker")) await ensureDockerImage();
  for (const [m, s] of legs) {
    console.log(`\n=== ${m}/${s} ===`);
    await runLeg(m, s);
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll legs passed");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
