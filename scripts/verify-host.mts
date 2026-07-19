/**
 * Live verification of the kimi-code provider against the real kimi CLI on
 * this host (no sandbox). Exercises the provider's actual commands and
 * parser end to end:
 *
 *   1. fresh print run → session_id emitted by the stream
 *   2. resume round-trip → same session id, context recalled
 *   3. fork round-trip → parent state.json byte-for-byte unchanged, fork
 *      resumes under a new id with forkedFrom stamped
 *
 * Uses the real ~/.kimi-code (host OAuth credentials) but a throwaway cwd.
 * Run with: npm run verify-host
 */

import { exec } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { kimiCode, kimiWorkDirKey } from "../src/index.js";

const execp = promisify(exec);
const MODEL = "kimi-code/k3";
const provider = kimiCode(MODEL);

let failures = 0;
const check = (label: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

interface RunOutcome {
  code: number;
  sessionId?: string;
  resultText: string;
  stderr: string;
}

const runProviderCommand = async (
  command: string,
  cwd: string,
): Promise<RunOutcome> => {
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    const result = await execp(command, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 240_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    code = typeof err.code === "number" ? err.code : 1;
  }
  let sessionId: string | undefined;
  let resultText = "";
  for (const line of stdout.split("\n")) {
    for (const event of provider.parseStreamLine(line)) {
      if (event.type === "session_id") sessionId = event.sessionId;
      if (event.type === "result") resultText = event.result;
    }
  }
  return { code, sessionId, resultText, stderr };
};

const kimiHome = join(process.env.HOME ?? "~", ".kimi-code");

const main = async (): Promise<void> => {
  const cwd = await mkdtemp(join(tmpdir(), "kimi-verify-"));
  console.log(`verify cwd: ${cwd}`);
  try {
    // 1. Fresh run -----------------------------------------------------------
    const fresh = provider.buildPrintCommand({
      prompt:
        "Reply with exactly: FRESH_OK. Also remember the codeword PINEAPPLE — you will be asked for it in later turns.",
      dangerouslySkipPermissions: true,
    });
    const r1 = await runProviderCommand(fresh.command, cwd);
    check("fresh run exits 0", r1.code === 0, `code=${r1.code} ${r1.stderr}`);
    check(
      "fresh run emits a session id",
      typeof r1.sessionId === "string" && r1.sessionId.startsWith("session_"),
      `sessionId=${r1.sessionId}`,
    );
    if (!r1.sessionId) throw new Error("no session id — cannot continue");

    // 2. Resume round-trip ---------------------------------------------------
    const resume = provider.buildPrintCommand({
      prompt: "What was the codeword? Reply with just the codeword.",
      dangerouslySkipPermissions: true,
      resumeSession: r1.sessionId,
    });
    const r2 = await runProviderCommand(resume.command, cwd);
    check("resume exits 0", r2.code === 0, `code=${r2.code} ${r2.stderr}`);
    check(
      "resume keeps the same session id",
      r2.sessionId === r1.sessionId,
      `${r2.sessionId} !== ${r1.sessionId}`,
    );
    check(
      "resume recalls context (PINEAPPLE)",
      r2.resultText.toUpperCase().includes("PINEAPPLE"),
      `result=${r2.resultText.slice(0, 120)}`,
    );

    // 3. Fork round-trip -----------------------------------------------------
    const bucket = kimiWorkDirKey(cwd);
    const parentStatePath = join(
      kimiHome,
      "sessions",
      bucket,
      r1.sessionId,
      "state.json",
    );
    const parentBefore = await readFile(parentStatePath, "utf-8");

    const fork = provider.buildPrintCommand({
      prompt: "What was the codeword? Reply with just the codeword.",
      dangerouslySkipPermissions: true,
      resumeSession: r1.sessionId,
      forkSession: true,
    });
    const r3 = await runProviderCommand(fork.command, cwd);
    check("fork exits 0", r3.code === 0, `code=${r3.code} ${r3.stderr}`);
    check(
      "fork resumes under a new session id",
      typeof r3.sessionId === "string" && r3.sessionId !== r1.sessionId,
      `sessionId=${r3.sessionId}`,
    );

    const parentAfter = await readFile(parentStatePath, "utf-8");
    check(
      "parent state.json is byte-for-byte unchanged after fork",
      parentBefore === parentAfter,
    );
    check(
      "fork recalls parent context (PINEAPPLE)",
      r3.resultText.toUpperCase().includes("PINEAPPLE"),
      `result=${r3.resultText.slice(0, 120)}`,
    );

    if (r3.sessionId && r3.sessionId !== r1.sessionId) {
      const forkState = JSON.parse(
        await readFile(
          join(kimiHome, "sessions", bucket, r3.sessionId, "state.json"),
          "utf-8",
        ),
      );
      check(
        "fork state.json has forkedFrom = parent id",
        forkState.forkedFrom === r1.sessionId,
        `forkedFrom=${forkState.forkedFrom}`,
      );

      const indexEntry = (await readFile(
        join(kimiHome, "session_index.jsonl"),
        "utf-8",
      ))
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l))
        .find((e) => e.sessionId === r3.sessionId);
      check(
        "fork is registered in session_index.jsonl",
        indexEntry?.sessionDir ===
          join(kimiHome, "sessions", bucket, r3.sessionId) &&
          indexEntry?.workDir === realpathSync(cwd),
        JSON.stringify(indexEntry),
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
