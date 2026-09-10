import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildKimiEnsureLocalScript,
  buildKimiForkScript,
  findKimiSessionOnHost,
  kimiWorkDirKey,
  kimiWorkDirKeyForRealPath,
  parseKimiUsageFromWire,
  rewriteKimiStateJson,
  rewriteKimiWireBinding,
  upsertKimiSessionIndex,
} from "./KimiSessionStore.js";

describe("kimiWorkDirKeyForRealPath", () => {
  // Every vector pinned by empirical probes against kimi 0.27.0 (bucket dir
  // names observed under ~/.kimi-code/sessions/ on macOS) and re-confirmed
  // against 0.42.0.
  const vectors: Array<[string, string]> = [
    [
      "/private/tmp/kimi-probe-xh8pmP",
      "wd_kimi-probe-xh8pmp_a08846732040",
    ],
    [
      "/private/tmp/kimi-probe2-wGlwQk",
      "wd_kimi-probe2-wglwqk_d86b44fdc942",
    ],
    ["/private/tmp/kimi slug test", "wd_kimi-slug-test_12a76e99bdef"],
    ["/private/tmp/kimi.slug.test", "wd_kimi.slug.test_200b66ff442c"],
    ["/private/tmp/KIMI-UPPER_test", "wd_kimi-upper_test_c5850c405a63"],
    ["/private/tmp/kimi@cute(test)", "wd_kimi-cute-test_fe40e2cc5749"],
    ["/private/tmp/kimi-测试 dir", "wd_kimi--dir_7211f90a27eb"],
    // kimi 0.42.0 truncates the slug to 40 chars (bucket observed live):
    [
      "/private/tmp/kimi-probe-with-a-very-long-directory-name-exceeding-forty-chars",
      "wd_kimi-probe-with-a-very-long-directory-na_8c30f06ee8f4",
    ],
  ];

  it.each(vectors)("computes %s → %s", (input, expected) => {
    expect(kimiWorkDirKeyForRealPath(input)).toBe(expected);
  });
});

describe("kimiWorkDirKey", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kimi-key-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves symlinks before hashing (matches the pure variant on the real path)", () => {
    expect(kimiWorkDirKey(dir)).toBe(
      kimiWorkDirKeyForRealPath(realpathSync(dir)),
    );
  });
});

// kimi 0.42 schema v2: the gate field is `cwd`; `agents` is a map whose
// entries each carry an absolute `homedir` into the session dir.
const SAMPLE_STATE = JSON.stringify(
  {
    createdAt: "2026-07-19T13:52:03.940Z",
    updatedAt: "2026-07-19T13:52:48.502Z",
    title: "Reply with exactly: PROBE_OK",
    isCustomTitle: false,
    agents: {
      main: {
        homedir:
          "/Users/x/.kimi-code/sessions/wd_a_000000000000/session_1/agents/main",
        type: "main",
      },
      "agent-0": {
        homedir:
          "/Users/x/.kimi-code/sessions/wd_a_000000000000/session_1/agents/agent-0",
        type: "subagent",
        parentAgentId: "main",
      },
    },
    custom: {},
    cwd: "/old/work/dir",
    lastPrompt: "hi",
  },
  null,
  2,
);

describe("rewriteKimiStateJson", () => {
  it("repoints cwd and every agent's homedir, preserving other fields", () => {
    const out = JSON.parse(
      rewriteKimiStateJson(SAMPLE_STATE, {
        workDir: "/new/dir",
        sessionDir: "/new/session",
      }),
    );
    expect(out.cwd).toBe("/new/dir");
    expect(out.agents.main.homedir).toBe("/new/session/agents/main");
    expect(out.agents["agent-0"].homedir).toBe("/new/session/agents/agent-0");
    expect(out.agents.main.type).toBe("main");
    expect(out.agents["agent-0"].parentAgentId).toBe("main");
    expect(out.title).toBe("Reply with exactly: PROBE_OK");
    expect(out.forkedFrom).toBeUndefined();
  });

  it("stamps forkedFrom when provided", () => {
    const out = JSON.parse(
      rewriteKimiStateJson(SAMPLE_STATE, {
        workDir: "/new/dir",
        sessionDir: "/new/session",
        forkedFrom: "session_parent",
      }),
    );
    expect(out.forkedFrom).toBe("session_parent");
  });
});

describe("rewriteKimiWireBinding", () => {
  const BINDING =
    '{"type":"runtime.set_binding","agentId":"main","runtimeId":"r1","workspaceId":"wd_old_000000000000"}';

  it("rewrites the binding workspaceId and leaves other lines byte-for-byte", () => {
    const input = `{"type":"metadata"}\n${BINDING}\n{"type":"turn.prompt"}\n`;
    const out = rewriteKimiWireBinding(input, "wd_new_111111111111");
    const lines = out.split("\n");
    expect(lines[0]).toBe('{"type":"metadata"}');
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "runtime.set_binding",
      agentId: "main",
      runtimeId: "r1",
      workspaceId: "wd_new_111111111111",
    });
    expect(lines[2]).toBe('{"type":"turn.prompt"}');
    expect(out.endsWith("\n")).toBe(true);
  });

  it("rewrites every binding record (a wire can accumulate several)", () => {
    const input = `${BINDING}\n${BINDING}\n`;
    const out = rewriteKimiWireBinding(input, "wd_new_111111111111");
    for (const line of out.trim().split("\n")) {
      expect(JSON.parse(line).workspaceId).toBe("wd_new_111111111111");
    }
  });

  it("returns the input unchanged when no binding record exists", () => {
    const input = '{"type":"metadata"}\nnot json\n';
    expect(rewriteKimiWireBinding(input, "wd_new_111111111111")).toBe(input);
  });

  it("leaves a malformed binding-looking line untouched", () => {
    const input = '{"type":"runtime.set_binding",broken\n';
    expect(rewriteKimiWireBinding(input, "wd_new_111111111111")).toBe(input);
  });
});

const USAGE_LINE =
  '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":361,"output":37,"inputCacheRead":21504,"inputCacheCreation":0},"usageScope":"turn","time":1784469437027}';

describe("parseKimiUsageFromWire", () => {
  it("maps a turn-scoped usage.record onto IterationUsage", () => {
    expect(parseKimiUsageFromWire(`{"type":"metadata"}\n${USAGE_LINE}\n`)).toEqual({
      inputTokens: 361,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 21504,
      outputTokens: 37,
    });
  });

  it("takes the last turn-scoped record", () => {
    const later =
      '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":10,"output":5,"inputCacheRead":2,"inputCacheCreation":1},"usageScope":"turn","time":1784469437999}';
    expect(
      parseKimiUsageFromWire(`${USAGE_LINE}\n${later}\n`),
    ).toEqual({
      inputTokens: 10,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      outputTokens: 5,
    });
  });

  it("ignores non-turn scopes and returns undefined without usage", () => {
    const sessionScope =
      '{"type":"usage.record","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4},"usageScope":"session"}';
    expect(parseKimiUsageFromWire(sessionScope)).toBeUndefined();
    expect(parseKimiUsageFromWire('{"type":"metadata"}\nnot json\n')).toBeUndefined();
  });

  it("skips malformed usage records and keeps scanning", () => {
    const broken =
      '{"type":"usage.record","usage":{"inputOther":"NaN"},"usageScope":"turn"}';
    expect(
      parseKimiUsageFromWire(`${broken}\n${USAGE_LINE}\n`),
    ).toEqual({
      inputTokens: 361,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 21504,
      outputTokens: 37,
    });
  });
});

describe("findKimiSessionOnHost", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kimi-sessions-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds a session by id across buckets", async () => {
    const wire = join(root, "wd_x_000000000000", "session_abc", "agents", "main");
    await mkdir(wire, { recursive: true });
    await writeFile(join(wire, "wire.jsonl"), "{}\n");
    const found = await findKimiSessionOnHost("session_abc", root);
    expect(found.path).toBe(join(wire, "wire.jsonl"));
    expect(found.searchedRoot).toBe(root);
  });

  it("returns undefined path when absent, ignoring non-bucket dirs", async () => {
    await mkdir(join(root, "notabucket", "session_abc", "agents", "main"), {
      recursive: true,
    });
    const found = await findKimiSessionOnHost("session_abc", root);
    expect(found.path).toBeUndefined();
    expect(found.searchedRoot).toBe(root);
  });
});

/** Write a v2 session fixture into <home>/sessions/<bucketOf(oldCwd)>/<id>. */
const writeHostSession = async (
  home: string,
  oldCwd: string,
  id: string,
): Promise<string> => {
  const dir = join(home, "sessions", kimiWorkDirKeyForRealPath(oldCwd), id);
  await mkdir(join(dir, "agents", "main"), { recursive: true });
  await mkdir(join(dir, "agents", "agent-0"), { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify(
      {
        cwd: oldCwd,
        title: "probe",
        agents: {
          main: { homedir: join(dir, "agents", "main"), type: "main" },
          "agent-0": {
            homedir: join(dir, "agents", "agent-0"),
            type: "subagent",
            parentAgentId: "main",
          },
        },
      },
      null,
      2,
    ),
  );
  const bucket = kimiWorkDirKeyForRealPath(oldCwd);
  await writeFile(
    join(dir, "agents", "main", "wire.jsonl"),
    `{"type":"runtime.set_binding","agentId":"main","runtimeId":"r1","workspaceId":"${bucket}"}\n{"main":1}\n`,
  );
  await writeFile(
    join(dir, "agents", "agent-0", "wire.jsonl"),
    `{"type":"runtime.set_binding","agentId":"agent-0","runtimeId":"r2","workspaceId":"${bucket}"}\n{"sub":1}\n`,
  );
  await writeFile(join(dir, "upcoming-goals.json"), '{"goals":["g1"]}\n');
  return dir;
};

describe("buildKimiEnsureLocalScript", () => {
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kimi-ensure-home-"));
    cwd = await mkdtemp(join(tmpdir(), "kimi-ensure-cwd-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const SID = "session_11111111-1111-4111-8111-111111111111";
  const runScript = (id: string = SID): void => {
    execFileSync(process.execPath, ["-e", buildKimiEnsureLocalScript(id)], {
      cwd,
      env: { ...process.env, KIMI_CODE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };

  it("contains no single quotes for well-formed ids (shell-escapes cleanly)", () => {
    expect(buildKimiEnsureLocalScript(SID)).not.toContain("'");
  });

  it("relocates a foreign-bucket session into the cwd bucket, rewrites state + binding + index, removes the source", async () => {
    const srcDir = await writeHostSession(home, "/old/dir", SID);
    runScript();

    const dstDir = join(home, "sessions", kimiWorkDirKey(cwd), SID);
    const state = JSON.parse(
      await readFile(join(dstDir, "state.json"), "utf-8"),
    );
    expect(state.cwd).toBe(realpathSync(cwd));
    expect(state.agents.main.homedir).toBe(join(dstDir, "agents", "main"));
    expect(state.agents["agent-0"].homedir).toBe(
      join(dstDir, "agents", "agent-0"),
    );

    const newBucket = kimiWorkDirKey(cwd);
    const mainWire = await readFile(
      join(dstDir, "agents", "main", "wire.jsonl"),
      "utf-8",
    );
    expect(JSON.parse(mainWire.split("\n")[0]!).workspaceId).toBe(newBucket);
    expect(mainWire.split("\n")[1]).toBe('{"main":1}');
    const subWire = await readFile(
      join(dstDir, "agents", "agent-0", "wire.jsonl"),
      "utf-8",
    );
    expect(JSON.parse(subWire.split("\n")[0]!).workspaceId).toBe(newBucket);

    // pending goals survive relocation (only forks drop them)
    expect(await readFile(join(dstDir, "upcoming-goals.json"), "utf-8")).toBe(
      '{"goals":["g1"]}\n',
    );

    const indexLines = (
      await readFile(join(home, "session_index.jsonl"), "utf-8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(indexLines).toEqual([
      { sessionId: SID, sessionDir: dstDir, workDir: realpathSync(cwd) },
    ]);

    // source removed only after a successful relocation
    await expect(readFile(join(srcDir, "state.json"), "utf-8")).rejects.toThrow();
  });

  it("falls back to a bucket scan when the index is missing", async () => {
    await writeHostSession(home, "/old/dir", SID);
    runScript();
    const dstDir = join(home, "sessions", kimiWorkDirKey(cwd), SID);
    const state = JSON.parse(
      await readFile(join(dstDir, "state.json"), "utf-8"),
    );
    expect(state.cwd).toBe(realpathSync(cwd));
  });

  it("is a no-op when the session is already local to the cwd", async () => {
    await writeHostSession(home, "/old/dir", SID);
    runScript();
    const dstDir = join(home, "sessions", kimiWorkDirKey(cwd), SID);
    const stateBefore = await readFile(join(dstDir, "state.json"), "utf-8");
    const indexBefore = await readFile(
      join(home, "session_index.jsonl"),
      "utf-8",
    );
    runScript();
    expect(await readFile(join(dstDir, "state.json"), "utf-8")).toBe(
      stateBefore,
    );
    expect(await readFile(join(home, "session_index.jsonl"), "utf-8")).toBe(
      indexBefore,
    );
  });

  it("fixes a stale-cwd session already sitting in the cwd bucket in place", async () => {
    // dst bucket exists but its state points elsewhere (e.g. a session
    // captured from a sandbox — cwd=/home/agent/workspace on the host).
    const srcDir = await writeHostSession(home, "/old/dir", SID);
    const dstDir = join(home, "sessions", kimiWorkDirKey(cwd), SID);
    await mkdir(join(home, "sessions", kimiWorkDirKey(cwd)), {
      recursive: true,
    });
    await execFileSync("mv", [srcDir, dstDir]);
    await writeFile(
      join(home, "session_index.jsonl"),
      JSON.stringify({
        sessionId: SID,
        sessionDir: dstDir,
        workDir: "/old/dir",
      }) + "\n",
    );

    runScript();

    const state = JSON.parse(
      await readFile(join(dstDir, "state.json"), "utf-8"),
    );
    expect(state.cwd).toBe(realpathSync(cwd));
    // in-place: the dir was NOT removed and recreated elsewhere
    const index = (
      await readFile(join(home, "session_index.jsonl"), "utf-8")
    ).trim();
    expect(JSON.parse(index).sessionDir).toBe(dstDir);
  });

  it("fails loudly when the session cannot be found", () => {
    let stderr = "";
    try {
      execFileSync(process.execPath, ["-e", buildKimiEnsureLocalScript(SID)], {
        cwd,
        env: { ...process.env, KIMI_CODE_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect.unreachable("script should have failed");
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    }
    expect(stderr).toContain("not found");
    expect(stderr).toContain(SID);
  });
});

describe("buildKimiForkScript", () => {
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kimi-fork-home-"));
    cwd = await mkdtemp(join(tmpdir(), "kimi-fork-cwd-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("contains no single quotes for well-formed ids (shell-escapes cleanly)", () => {
    expect(
      buildKimiForkScript(
        "session_11111111-1111-4111-8111-111111111111",
        "session_22222222-2222-4222-8222-222222222222",
      ),
    ).not.toContain("'");
  });

  it("copies the session dir, repoints state.json (v2, all agents), drops pending goals, and leaves the parent byte-for-byte unchanged", async () => {
    const parent = "session_11111111-1111-4111-8111-111111111111";
    const newId = "session_22222222-2222-4222-8222-222222222222";
    const parentDir = await writeHostSession(home, realpathSync(cwd), parent);
    const parentState = await readFile(join(parentDir, "state.json"), "utf-8");

    const script = buildKimiForkScript(parent, newId);
    execFileSync(process.execPath, ["-e", script], {
      cwd,
      env: { ...process.env, KIMI_CODE_HOME: home },
    });

    expect(await readFile(join(parentDir, "state.json"), "utf-8")).toBe(
      parentState,
    );

    const forkDir = join(home, "sessions", kimiWorkDirKey(cwd), newId);
    const forked = JSON.parse(
      await readFile(join(forkDir, "state.json"), "utf-8"),
    );
    expect(forked.forkedFrom).toBe(parent);
    expect(forked.cwd).toBe(realpathSync(cwd));
    expect(forked.agents.main.homedir).toBe(join(forkDir, "agents", "main"));
    expect(forked.agents["agent-0"].homedir).toBe(
      join(forkDir, "agents", "agent-0"),
    );
    // pending goals are NOT inherited by a fork (ADR 0001)
    await expect(
      readFile(join(forkDir, "upcoming-goals.json"), "utf-8"),
    ).rejects.toThrow();
    // the wire (and its binding, already local) is carried over untouched
    const forkWire = await readFile(
      join(forkDir, "agents", "main", "wire.jsonl"),
      "utf-8",
    );
    expect(JSON.parse(forkWire.split("\n")[0]!).workspaceId).toBe(
      kimiWorkDirKey(cwd),
    );

    // fork registered in the session index (kimi gates resume-by-id on it)
    const indexLines = (
      await readFile(join(home, "session_index.jsonl"), "utf-8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(indexLines).toEqual([
      { sessionId: newId, sessionDir: forkDir, workDir: realpathSync(cwd) },
    ]);
  });
});

describe("upsertKimiSessionIndex", () => {
  const entry = {
    sessionId: "session_a",
    sessionDir: "/x/session_a",
    workDir: "/w",
  };

  it("appends a new entry to an empty index", () => {
    expect(upsertKimiSessionIndex("", entry)).toBe(
      JSON.stringify(entry) + "\n",
    );
  });

  it("replaces an existing entry for the same id, keeping others", () => {
    const other = {
      sessionId: "session_b",
      sessionDir: "/y/session_b",
      workDir: "/w2",
    };
    const stale = {
      sessionId: "session_a",
      sessionDir: "/old/session_a",
      workDir: "/oldw",
    };
    const input = JSON.stringify(other) + "\n" + JSON.stringify(stale) + "\n";
    const lines = upsertKimiSessionIndex(input, entry)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([other, entry]);
  });

  it("preserves malformed lines", () => {
    expect(upsertKimiSessionIndex("not json\n", entry)).toBe(
      "not json\n" + JSON.stringify(entry) + "\n",
    );
  });
});
