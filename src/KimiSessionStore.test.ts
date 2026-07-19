import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildKimiForkScript,
  findKimiSessionOnHost,
  kimiWorkDirKey,
  kimiWorkDirKeyForRealPath,
  parseKimiUsageFromWire,
  rewriteKimiStateJson,
  upsertKimiSessionIndex,
} from "./KimiSessionStore.js";

describe("kimiWorkDirKeyForRealPath", () => {
  // Every vector pinned by empirical probes against kimi 0.27.0 (bucket dir
  // names observed under ~/.kimi-code/sessions/ on macOS).
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
        parentAgentId: null,
      },
    },
    custom: {},
    workDir: "/old/work/dir",
    lastPrompt: "hi",
  },
  null,
  2,
);

describe("rewriteKimiStateJson", () => {
  it("repoints workDir and agents.main.homedir, preserving other fields", () => {
    const out = JSON.parse(
      rewriteKimiStateJson(SAMPLE_STATE, {
        workDir: "/new/dir",
        agentHomedir: "/new/session/agents/main",
      }),
    );
    expect(out.workDir).toBe("/new/dir");
    expect(out.agents.main.homedir).toBe("/new/session/agents/main");
    expect(out.agents.main.type).toBe("main");
    expect(out.title).toBe("Reply with exactly: PROBE_OK");
    expect(out.forkedFrom).toBeUndefined();
  });

  it("stamps forkedFrom when provided", () => {
    const out = JSON.parse(
      rewriteKimiStateJson(SAMPLE_STATE, {
        workDir: "/new/dir",
        agentHomedir: "/new/session/agents/main",
        forkedFrom: "session_parent",
      }),
    );
    expect(out.forkedFrom).toBe("session_parent");
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

  it("copies the session dir, repoints state.json, and leaves the parent byte-for-byte unchanged", async () => {
    const key = kimiWorkDirKey(cwd);
    const parent = "session_11111111-1111-4111-8111-111111111111";
    const newId = "session_22222222-2222-4222-8222-222222222222";
    const parentDir = join(home, "sessions", key, parent);
    await mkdir(join(parentDir, "agents", "main"), { recursive: true });
    const parentState = JSON.stringify(
      {
        workDir: realpathSync(cwd),
        title: "parent",
        agents: {
          main: {
            homedir: join(parentDir, "agents", "main"),
            type: "main",
            parentAgentId: null,
          },
        },
      },
      null,
      2,
    );
    await writeFile(join(parentDir, "state.json"), parentState);
    await writeFile(
      join(parentDir, "agents", "main", "wire.jsonl"),
      '{"type":"metadata"}\n',
    );

    const script = buildKimiForkScript(parent, newId);
    execFileSync(process.execPath, ["-e", script], {
      cwd,
      env: { ...process.env, KIMI_CODE_HOME: home },
    });

    expect(await readFile(join(parentDir, "state.json"), "utf-8")).toBe(
      parentState,
    );

    const forkDir = join(home, "sessions", key, newId);
    const forked = JSON.parse(
      await readFile(join(forkDir, "state.json"), "utf-8"),
    );
    expect(forked.forkedFrom).toBe(parent);
    expect(forked.workDir).toBe(realpathSync(cwd));
    expect(forked.agents.main.homedir).toBe(join(forkDir, "agents", "main"));
    expect(
      await readFile(join(forkDir, "agents", "main", "wire.jsonl"), "utf-8"),
    ).toBe('{"type":"metadata"}\n');

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
