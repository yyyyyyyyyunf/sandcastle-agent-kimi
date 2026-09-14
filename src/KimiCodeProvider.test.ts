import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BindMountSandboxHandle } from "@fly4ai/sandcastle";
import {
  isKimiVersionLayoutSupported,
  kimiCode,
} from "./KimiCodeProvider.js";
import {
  KIMI_MAIN_WIRE_REL,
  kimiWorkDirKeyForRealPath,
} from "./KimiSessionStore.js";

describe("kimiCode factory", () => {
  it("has the expected name, env, and captureSessions default", () => {
    const provider = kimiCode({ model: "kimi-code/k3" });
    expect(provider.name).toBe("kimi-code");
    expect(provider.env).toEqual({});
    expect(provider.captureSessions).toBe(true);
  });

  it("passes env through and honours captureSessions: false", () => {
    const provider = kimiCode({
      model: "kimi-code/k3",
      env: { KIMI_MODEL_NAME: "x" },
      captureSessions: false,
    });
    expect(provider.env).toEqual({ KIMI_MODEL_NAME: "x" });
    expect(provider.captureSessions).toBe(false);
  });

  describe("env-synthesized model path (apiKey set)", () => {
    it("synthesises the KIMI_MODEL_* env and points -m at the internal alias", () => {
      const provider = kimiCode({
        model: "kimi-for-coding",
        apiKey: "sk-test",
      });
      expect(provider.env).toEqual({
        KIMI_MODEL_NAME: "kimi-for-coding",
        KIMI_MODEL_API_KEY: "sk-test",
      });
      const { command } = provider.buildPrintCommand({
        prompt: "hello",
        dangerouslySkipPermissions: true,
      });
      expect(command).toBe(
        `kimi -p 'hello' --output-format stream-json -m '__kimi_env_model__'`,
      );
    });

    it("translates baseUrl and providerType", () => {
      const provider = kimiCode({
        model: "gpt-4.1",
        apiKey: "sk-test",
        baseUrl: "https://api.example.com/v1",
        providerType: "openai",
      });
      expect(provider.env).toEqual({
        KIMI_MODEL_NAME: "gpt-4.1",
        KIMI_MODEL_API_KEY: "sk-test",
        KIMI_MODEL_BASE_URL: "https://api.example.com/v1",
        KIMI_MODEL_PROVIDER_TYPE: "openai",
      });
    });

    it("first-class fields win over same-named env entries", () => {
      const provider = kimiCode({
        model: "kimi-for-coding",
        apiKey: "sk-field",
        env: {
          KIMI_MODEL_NAME: "stale-name",
          KIMI_MODEL_API_KEY: "sk-stale",
          KIMI_CODE_HOME: "/custom/kimi-home",
        },
      });
      expect(provider.env).toEqual({
        KIMI_MODEL_NAME: "kimi-for-coding",
        KIMI_MODEL_API_KEY: "sk-field",
        KIMI_CODE_HOME: "/custom/kimi-home",
      });
    });
  });

  describe("effort", () => {
    it("injects KIMI_MODEL_THINKING_EFFORT on the env-synthesized path", () => {
      const provider = kimiCode({
        model: "kimi-for-coding",
        apiKey: "sk-test",
        effort: "max",
      });
      expect(provider.env.KIMI_MODEL_THINKING_EFFORT).toBe("max");
    });

    it("injects KIMI_MODEL_THINKING_EFFORT on the alias path too", () => {
      const provider = kimiCode({ model: "kimi-code/k3", effort: "low" });
      expect(provider.env.KIMI_MODEL_THINKING_EFFORT).toBe("low");
    });

    it("wins over an env-set KIMI_MODEL_THINKING_EFFORT", () => {
      const provider = kimiCode({
        model: "kimi-code/k3",
        effort: "high",
        env: { KIMI_MODEL_THINKING_EFFORT: "low" },
      });
      expect(provider.env.KIMI_MODEL_THINKING_EFFORT).toBe("high");
    });

    it("does not inject the variable when effort is unset", () => {
      const provider = kimiCode({ model: "kimi-code/k3" });
      expect(provider.env).toEqual({});
    });
  });

  describe("buildPrintCommand", () => {
    it("builds a fresh print command", () => {
      const provider = kimiCode({ model: "kimi-code/k3" });
      expect(provider.buildPrintCommand({ prompt: "hello", dangerouslySkipPermissions: true })).toEqual({
        command: `kimi -p 'hello' --output-format stream-json -m 'kimi-code/k3'`,
      });
    });

    it("shell-escapes the prompt and model", () => {
      const provider = kimiCode({ model: "m'odel" });
      const { command } = provider.buildPrintCommand({
        prompt: "it's here",
        dangerouslySkipPermissions: true,
      });
      expect(command).toBe(
        `kimi -p 'it'\\''s here' --output-format stream-json -m 'm'\\''odel'`,
      );
    });

    it("prepends an ensure-local relocate step for resume, then appends --session", () => {
      const provider = kimiCode({ model: "kimi-code/k3" });
      const { command } = provider.buildPrintCommand({
        prompt: "go on",
        dangerouslySkipPermissions: true,
        resumeSession: "session_abc",
      });
      expect(command).toMatch(/^node -e '.+' && kimi -p 'go on' /);
      expect(command).toContain("session_abc");
      expect(command).toMatch(/--session 'session_abc'$/);
    });

    it("forks via ensure-local + storage-layer copy and resumes the new id", () => {
      const provider = kimiCode({ model: "kimi-code/k3" });
      const { command } = provider.buildPrintCommand({
        prompt: "go on",
        dangerouslySkipPermissions: true,
        resumeSession: "session_parent",
        forkSession: true,
      });
      expect(command).toMatch(/^node -e '.+' && node -e '.+' && kimi -p /);
      expect(command).toContain("session_parent");
      const sessionFlag = command.match(/--session '([^']+)'/);
      expect(sessionFlag).not.toBeNull();
      expect(sessionFlag![1]).toMatch(
        /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(sessionFlag![1]).not.toBe("session_parent");
    });

    it("throws when the prompt exceeds the argv budget", () => {
      const provider = kimiCode({ model: "kimi-code/k3" });
      expect(() =>
        provider.buildPrintCommand({
          prompt: "x".repeat(121 * 1024),
          dangerouslySkipPermissions: true,
        }),
      ).toThrow(/max 122880 bytes/);
    });
  });

  describe("parseStreamLine", () => {
    const provider = kimiCode({ model: "kimi-code/k3" });
    const parse = provider.parseStreamLine;

    it("maps assistant content to text + result", () => {
      expect(parse('{"role":"assistant","content":"PROBE_OK"}')).toEqual([
        { type: "text", text: "PROBE_OK" },
        { type: "result", result: "PROBE_OK" },
      ]);
    });

    it("collapses array-shaped content blocks defensively", () => {
      expect(
        parse(
          '{"role":"assistant","content":[{"type":"text","text":"PRO"},{"type":"text","text":"BE_OK"}]}',
        ),
      ).toEqual([
        { type: "text", text: "PROBE_OK" },
        { type: "result", result: "PROBE_OK" },
      ]);
    });

    it("maps tool_calls with an allowlisted display arg (Bash.command)", () => {
      const line =
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_Gcs77aPSiUIimvCEEqe7SO0x","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}';
      expect(parse(line)).toEqual([
        { type: "tool_call", name: "Bash", args: "ls" },
      ]);
    });

    it("falls back to a JSON dump for non-allowlisted tools (Write)", () => {
      const line =
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_jh6okkmAVPSMkI9JG1q6Tiu7","function":{"name":"Write","arguments":"{\\"path\\":\\"hello.txt\\",\\"content\\":\\"hi\\"}"}}]}';
      expect(parse(line)).toEqual([
        {
          type: "tool_call",
          name: "Write",
          args: '{"path":"hello.txt","content":"hi"}',
        },
      ]);
    });

    it("keeps the raw arguments string when it is not valid JSON", () => {
      const line =
        '{"role":"assistant","tool_calls":[{"type":"function","id":"t","function":{"name":"Bash","arguments":"not json"}}]}';
      expect(parse(line)).toEqual([
        { type: "tool_call", name: "Bash", args: "not json" },
      ]);
    });

    it("maps assistant messages carrying content AND tool_calls in one line", () => {
      const line =
        '{"role":"assistant","content":"checking","tool_calls":[{"type":"function","id":"t1","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}';
      expect(parse(line)).toEqual([
        { type: "tool_call", name: "Bash", args: "ls" },
        { type: "text", text: "checking" },
        { type: "result", result: "checking" },
      ]);
    });

    it("skips tool result messages", () => {
      expect(
        parse(
          '{"role":"tool","tool_call_id":"tool_x","content":"hello.txt\\n"}',
        ),
      ).toEqual([]);
    });

    it("extracts the session id from the resume_hint meta event", () => {
      const line =
        '{"role":"meta","type":"session.resume_hint","session_id":"session_6c30ba1d-dcd4-409c-bb13-a64774b5c480","command":"kimi -r session_6c30ba1d-dcd4-409c-bb13-a64774b5c480","content":"To resume this session: kimi -r session_6c30ba1d-dcd4-409c-bb13-a64774b5c480"}';
      expect(parse(line)).toEqual([
        {
          type: "session_id",
          sessionId: "session_6c30ba1d-dcd4-409c-bb13-a64774b5c480",
        },
      ]);
    });

    it("surfaces error events as result events (defensive)", () => {
      expect(parse('{"type":"error","error":{"message":"boom"}}')).toEqual([
        { type: "result", result: "boom" },
      ]);
      expect(parse('{"type":"agent_error","error":"kaput"}')).toEqual([
        { type: "result", result: "kaput" },
      ]);
    });

    it("returns [] for non-JSON and empty content", () => {
      expect(parse("not json")).toEqual([]);
      expect(parse('{"role":"assistant","content":""}')).toEqual([]);
    });
  });

  describe("parseSessionUsage", () => {
    it("parses the last turn-scoped usage.record from wire content", () => {
      const provider = kimiCode({ model: "kimi-code/k3" });
      const wire =
        '{"type":"metadata"}\n{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":361,"output":37,"inputCacheRead":21504,"inputCacheCreation":0},"usageScope":"turn","time":1784469437027}\n';
      expect(provider.parseSessionUsage!(wire)).toEqual({
        inputTokens: 361,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 21504,
        outputTokens: 37,
      });
    });
  });
});

describe("isKimiVersionLayoutSupported", () => {
  it("accepts the verified floor and above, warns below, ignores noise", () => {
    expect(isKimiVersionLayoutSupported("0.42.0")).toBe(true);
    expect(isKimiVersionLayoutSupported("0.42.1")).toBe(true);
    expect(isKimiVersionLayoutSupported("1.0.0")).toBe(true);
    expect(isKimiVersionLayoutSupported("0.41.0")).toBe(false);
    expect(isKimiVersionLayoutSupported("0.27.0")).toBe(false);
    expect(isKimiVersionLayoutSupported("not-a-version")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sessionStorage round-trip (fake BindMountSandboxHandle over tmp dirs)
// ---------------------------------------------------------------------------

const SANDBOX_SESSIONS = "/home/agent/.kimi-code/sessions";

/** Map sandbox-absolute paths into a host tmp dir; fake exec/copyFile* over it. */
const makeFakeHandle = (sandboxFsRoot: string): BindMountSandboxHandle => {
  const map = (p: string): string => join(sandboxFsRoot, p);
  const unmap = (hostPath: string): string =>
    "/" + relative(sandboxFsRoot, hostPath);

  return {
    worktreePath: "/workspace/repo",
    exec: async (command: string) => {
      const find = command.match(/^find "(.+)" -type f$/);
      if (find) {
        const files: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          const entries = await readdir(dir, { withFileTypes: true }).catch(
            () => [],
          );
          for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else files.push(full);
          }
        };
        await walk(map(find[1]!));
        return {
          stdout: files.map(unmap).join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      const realpath = command.match(/^realpath "(.+)"$/);
      if (realpath) {
        return { stdout: realpath[1]! + "\n", stderr: "", exitCode: 0 };
      }
      const mkdirMatch = command.match(/^mkdir -p "(.+)"$/);
      if (mkdirMatch) {
        await mkdir(map(mkdirMatch[1]!), { recursive: true });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`fake handle: unsupported command: ${command}`);
    },
    copyFileIn: async (hostPath, sandboxPath) => {
      await copyFile(hostPath, map(sandboxPath));
    },
    copyFileOut: async (sandboxPath, hostPath) => {
      await copyFile(map(sandboxPath), hostPath);
    },
    close: async () => {},
  };
};

const writeSandboxSession = async (
  sandboxFsRoot: string,
  sandboxCwd: string,
  sessionId: string,
  sessionsRoot: string = SANDBOX_SESSIONS,
): Promise<string> => {
  const dir = join(
    sandboxFsRoot,
    sessionsRoot,
    kimiWorkDirKeyForRealPath(sandboxCwd),
    sessionId,
  );
  const sandboxBucket = kimiWorkDirKeyForRealPath(sandboxCwd);
  await mkdir(join(dir, "agents", "main"), { recursive: true });
  await mkdir(join(dir, "agents", "agent-0"), { recursive: true });
  await mkdir(join(dir, "logs"), { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify(
      {
        cwd: sandboxCwd,
        title: "probe",
        agents: {
          main: {
            homedir: `${dir.slice(sandboxFsRoot.length)}/agents/main`,
            type: "main",
          },
          "agent-0": {
            homedir: `${dir.slice(sandboxFsRoot.length)}/agents/agent-0`,
            type: "subagent",
            parentAgentId: "main",
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, "agents", "main", "wire.jsonl"),
    `{"type":"runtime.set_binding","agentId":"main","runtimeId":"r1","workspaceId":"${sandboxBucket}"}\n{"main":1}\n`,
  );
  await writeFile(
    join(dir, "agents", "agent-0", "wire.jsonl"),
    `{"type":"runtime.set_binding","agentId":"agent-0","runtimeId":"r2","workspaceId":"${sandboxBucket}"}\n{"sub":1}\n`,
  );
  await writeFile(join(dir, "upcoming-goals.json"), '{"goals":["g1"]}\n');
  await writeFile(join(dir, "logs", "kimi-code.log"), "diagnostic\n");
  return dir;
};

describe("sessionStorage", () => {
  let hostCwd: string;
  let hostHome: string;
  let hostSessionsDir: string;
  let sandboxFsRoot: string;
  let handle: BindMountSandboxHandle;
  const sessionId = "session_6c30ba1d-dcd4-409c-bb13-a64774b5c480";

  const makeProvider = () =>
    kimiCode({
      model: "kimi-code/k3",
      sessionStorage: {
        hostSessionsDir,
        sandboxSessionsDir: SANDBOX_SESSIONS,
      },
    });

  beforeEach(async () => {
    hostCwd = await mkdtemp(join(tmpdir(), "kimi-host-cwd-"));
    hostHome = await mkdtemp(join(tmpdir(), "kimi-host-home-"));
    hostSessionsDir = join(hostHome, "sessions");
    sandboxFsRoot = await mkdtemp(join(tmpdir(), "kimi-sandbox-fs-"));
    handle = makeFakeHandle(sandboxFsRoot);
  });
  afterEach(async () => {
    await rm(hostCwd, { recursive: true, force: true });
    await rm(hostHome, { recursive: true, force: true });
    await rm(sandboxFsRoot, { recursive: true, force: true });
  });

  it("captureToHost transfers the session record, rewriting cwd + homedirs + wire binding to the host side", async () => {
    const sandboxCwd = "/workspace/repo";
    await writeSandboxSession(sandboxFsRoot, sandboxCwd, sessionId);

    const provider = makeProvider();
    await provider.sessionStorage.captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId,
      handle,
    });

    const hostBucket = kimiWorkDirKeyForRealPath(realpathSync(hostCwd));
    const hostDir = join(hostSessionsDir, hostBucket, sessionId);
    const state = JSON.parse(
      await readFile(join(hostDir, "state.json"), "utf-8"),
    );
    expect(state.cwd).toBe(realpathSync(hostCwd));
    expect(state.agents.main.homedir).toBe(join(hostDir, "agents", "main"));
    expect(state.agents["agent-0"].homedir).toBe(
      join(hostDir, "agents", "agent-0"),
    );
    expect(state.title).toBe("probe");

    // wire bindings rebound to the host bucket, content lines preserved
    const mainWire = await readFile(join(hostDir, KIMI_MAIN_WIRE_REL), "utf-8");
    const mainLines = mainWire.split("\n");
    expect(JSON.parse(mainLines[0]!).workspaceId).toBe(hostBucket);
    expect(mainLines[1]).toBe('{"main":1}');
    const subWire = await readFile(
      join(hostDir, "agents", "agent-0", "wire.jsonl"),
      "utf-8",
    );
    expect(JSON.parse(subWire.split("\n")[0]!).workspaceId).toBe(hostBucket);

    // pending goals survive capture (only forks drop them)
    expect(await readFile(join(hostDir, "upcoming-goals.json"), "utf-8")).toBe(
      '{"goals":["g1"]}\n',
    );
    // logs are not part of the session record
    await expect(
      readFile(join(hostDir, "logs", "kimi-code.log"), "utf-8"),
    ).rejects.toThrow();

    expect(await provider.sessionStorage.existsOnHost(hostCwd, sessionId)).toBe(
      true,
    );
    expect(provider.sessionStorage.hostSessionFilePath(hostCwd, sessionId)).toBe(
      join(hostDir, KIMI_MAIN_WIRE_REL),
    );
    expect(
      await provider.sessionStorage.readHostSession(hostCwd, sessionId),
    ).toBe(mainWire);

    // session registered in the host index (kimi gates resume-by-id on it)
    const indexEntry = {
      sessionId,
      sessionDir: hostDir,
      workDir: realpathSync(hostCwd),
    };
    expect(
      await readFile(join(hostHome, "session_index.jsonl"), "utf-8"),
    ).toBe(JSON.stringify(indexEntry) + "\n");

    // a second capture (next iteration) upserts rather than duplicating
    await provider.sessionStorage.captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId,
      handle,
    });
    expect(
      await readFile(join(hostHome, "session_index.jsonl"), "utf-8"),
    ).toBe(JSON.stringify(indexEntry) + "\n");
  });

  it("captureToHost keeps every session's index entry under concurrent captures", async () => {
    const sandboxCwd = "/workspace/repo";
    const otherId = "session_7d41cbe2-5f1c-4b3a-9f7e-2a2f9e2b1c10";
    await writeSandboxSession(sandboxFsRoot, sandboxCwd, sessionId);
    await writeSandboxSession(sandboxFsRoot, sandboxCwd, otherId);

    const provider = makeProvider();
    await Promise.all(
      [sessionId, otherId].map((id) =>
        provider.sessionStorage.captureToHost({
          hostCwd,
          sandboxCwd,
          sessionId: id,
          handle,
        }),
      ),
    );

    const lines = (
      await readFile(join(hostHome, "session_index.jsonl"), "utf-8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).sessionId)
      .sort();
    expect(lines).toEqual([otherId, sessionId].sort());
  });

  it("captureToHost throws when the session is missing from the sandbox", async () => {
    const provider = makeProvider();
    await expect(
      provider.sessionStorage.captureToHost({
        hostCwd,
        sandboxCwd: "/workspace/repo",
        sessionId: "session_missing",
        handle,
      }),
    ).rejects.toThrow(/missing state\.json/);
  });

  it("derives sandboxSessionsDir from env.KIMI_CODE_HOME when not overridden", async () => {
    const customRoot = "/custom/kimi-home/sessions";
    await writeSandboxSession(
      sandboxFsRoot,
      "/workspace/repo",
      sessionId,
      customRoot,
    );
    const provider = kimiCode({
      model: "kimi-code/k3",
      env: { KIMI_CODE_HOME: "/custom/kimi-home" },
      sessionStorage: { hostSessionsDir },
    });
    await provider.sessionStorage.captureToHost({
      hostCwd,
      sandboxCwd: "/workspace/repo",
      sessionId,
      handle,
    });
    // found the session under the env-derived sandbox root
    const hostDir = join(
      hostSessionsDir,
      kimiWorkDirKeyForRealPath(realpathSync(hostCwd)),
      sessionId,
    );
    const state = JSON.parse(
      await readFile(join(hostDir, "state.json"), "utf-8"),
    );
    expect(state.cwd).toBe(realpathSync(hostCwd));
  });

  it("resumeIntoSandbox transfers back with cwd + homedirs + wire binding rewritten to the new sandbox cwd", async () => {
    const firstCwd = "/workspace/repo";
    const secondCwd = "/workspace/other";
    await writeSandboxSession(sandboxFsRoot, firstCwd, sessionId);
    const provider = makeProvider();
    await provider.sessionStorage.captureToHost({
      hostCwd,
      sandboxCwd: firstCwd,
      sessionId,
      handle,
    });

    await provider.sessionStorage.resumeIntoSandbox({
      hostCwd,
      sandboxCwd: secondCwd,
      sessionId,
      handle,
    });

    const secondBucket = kimiWorkDirKeyForRealPath(secondCwd);
    const resumedDir = join(
      sandboxFsRoot,
      SANDBOX_SESSIONS,
      secondBucket,
      sessionId,
    );
    const state = JSON.parse(
      await readFile(join(resumedDir, "state.json"), "utf-8"),
    );
    expect(state.cwd).toBe(secondCwd);
    expect(state.agents.main.homedir).toBe(
      `${SANDBOX_SESSIONS}/${secondBucket}/${sessionId}/agents/main`,
    );
    expect(state.agents["agent-0"].homedir).toBe(
      `${SANDBOX_SESSIONS}/${secondBucket}/${sessionId}/agents/agent-0`,
    );
    const wire = await readFile(join(resumedDir, KIMI_MAIN_WIRE_REL), "utf-8");
    expect(JSON.parse(wire.split("\n")[0]!).workspaceId).toBe(secondBucket);
    expect(wire.split("\n")[1]).toBe('{"main":1}');
    // pending goals survive resume
    expect(
      await readFile(join(resumedDir, "upcoming-goals.json"), "utf-8"),
    ).toBe('{"goals":["g1"]}\n');

    // session registered in the sandbox index (same gating as on the host)
    const sandboxIndex = JSON.parse(
      await readFile(
        join(sandboxFsRoot, "/home/agent/.kimi-code/session_index.jsonl"),
        "utf-8",
      ),
    );
    expect(sandboxIndex).toEqual({
      sessionId,
      sessionDir: `${SANDBOX_SESSIONS}/${secondBucket}/${sessionId}`,
      workDir: secondCwd,
    });
  });

  it("resumeIntoSandbox throws when the session is missing on the host", async () => {
    const provider = makeProvider();
    await expect(
      provider.sessionStorage.resumeIntoSandbox({
        hostCwd,
        sandboxCwd: "/workspace/repo",
        sessionId: "session_missing",
        handle,
      }),
    ).rejects.toThrow(/not found on the host/);
  });

  it("findByIdOnHost locates a captured session by id", async () => {
    await writeSandboxSession(sandboxFsRoot, "/workspace/repo", sessionId);
    const provider = makeProvider();
    await provider.sessionStorage.captureToHost({
      hostCwd,
      sandboxCwd: "/workspace/repo",
      sessionId,
      handle,
    });

    const found = await provider.sessionStorage.findByIdOnHost(sessionId);
    expect(found.path).toBe(
      provider.sessionStorage.hostSessionFilePath(hostCwd, sessionId),
    );
    expect(found.searchedRoot).toBe(hostSessionsDir);

    const missing = await provider.sessionStorage.findByIdOnHost(
      "session_missing",
    );
    expect(missing.path).toBeUndefined();
  });
});
