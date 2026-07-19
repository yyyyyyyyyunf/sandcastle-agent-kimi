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
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle";
import { kimiCode } from "./KimiCodeProvider.js";
import {
  KIMI_MAIN_WIRE_REL,
  kimiWorkDirKeyForRealPath,
} from "./KimiSessionStore.js";

describe("kimiCode factory", () => {
  it("has the expected name, env, and captureSessions default", () => {
    const provider = kimiCode("kimi-code/k3");
    expect(provider.name).toBe("kimi-code");
    expect(provider.env).toEqual({});
    expect(provider.captureSessions).toBe(true);
  });

  it("passes env through and honours captureSessions: false", () => {
    const provider = kimiCode("kimi-code/k3", {
      env: { KIMI_MODEL_NAME: "x" },
      captureSessions: false,
    });
    expect(provider.env).toEqual({ KIMI_MODEL_NAME: "x" });
    expect(provider.captureSessions).toBe(false);
  });

  describe("buildPrintCommand", () => {
    it("builds a fresh print command", () => {
      const provider = kimiCode("kimi-code/k3");
      expect(provider.buildPrintCommand({ prompt: "hello", dangerouslySkipPermissions: true })).toEqual({
        command: `kimi -p 'hello' --output-format stream-json -m 'kimi-code/k3'`,
      });
    });

    it("shell-escapes the prompt and model", () => {
      const provider = kimiCode("m'odel");
      const { command } = provider.buildPrintCommand({
        prompt: "it's here",
        dangerouslySkipPermissions: true,
      });
      expect(command).toBe(
        `kimi -p 'it'\\''s here' --output-format stream-json -m 'm'\\''odel'`,
      );
    });

    it("appends --session for resume", () => {
      const provider = kimiCode("kimi-code/k3");
      const { command } = provider.buildPrintCommand({
        prompt: "go on",
        dangerouslySkipPermissions: true,
        resumeSession: "session_abc",
      });
      expect(command).toBe(
        `kimi -p 'go on' --output-format stream-json -m 'kimi-code/k3' --session 'session_abc'`,
      );
    });

    it("forks via a storage-layer copy and resumes the new id", () => {
      const provider = kimiCode("kimi-code/k3");
      const { command } = provider.buildPrintCommand({
        prompt: "go on",
        dangerouslySkipPermissions: true,
        resumeSession: "session_parent",
        forkSession: true,
      });
      expect(command).toMatch(/^node -e '.+' && kimi -p /);
      expect(command).toContain("session_parent");
      const sessionFlag = command.match(/--session '([^']+)'/);
      expect(sessionFlag).not.toBeNull();
      expect(sessionFlag![1]).toMatch(
        /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(sessionFlag![1]).not.toBe("session_parent");
    });

    it("throws when the prompt exceeds the argv budget", () => {
      const provider = kimiCode("kimi-code/k3");
      expect(() =>
        provider.buildPrintCommand({
          prompt: "x".repeat(121 * 1024),
          dangerouslySkipPermissions: true,
        }),
      ).toThrow(/max 122880 bytes/);
    });
  });

  describe("parseStreamLine", () => {
    const provider = kimiCode("kimi-code/k3");
    const parse = provider.parseStreamLine;

    it("maps assistant content to text + result", () => {
      expect(parse('{"role":"assistant","content":"PROBE_OK"}')).toEqual([
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
    });

    it("returns [] for non-JSON and empty content", () => {
      expect(parse("not json")).toEqual([]);
      expect(parse('{"role":"assistant","content":""}')).toEqual([]);
    });
  });

  describe("parseSessionUsage", () => {
    it("parses the last turn-scoped usage.record from wire content", () => {
      const provider = kimiCode("kimi-code/k3");
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
): Promise<string> => {
  const dir = join(
    sandboxFsRoot,
    SANDBOX_SESSIONS,
    kimiWorkDirKeyForRealPath(sandboxCwd),
    sessionId,
  );
  await mkdir(join(dir, "agents", "main"), { recursive: true });
  await mkdir(join(dir, "agents", "agent-0"), { recursive: true });
  await mkdir(join(dir, "logs"), { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify(
      {
        workDir: sandboxCwd,
        title: "probe",
        agents: {
          main: {
            homedir: `${dir.slice(sandboxFsRoot.length)}/agents/main`,
            type: "main",
            parentAgentId: null,
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(join(dir, "agents", "main", "wire.jsonl"), '{"main":1}\n');
  await writeFile(
    join(dir, "agents", "agent-0", "wire.jsonl"),
    '{"sub":1}\n',
  );
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
    kimiCode("kimi-code/k3", {
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

  it("captureToHost transfers the session record, rewriting state.json to the host cwd", async () => {
    const sandboxCwd = "/workspace/repo";
    await writeSandboxSession(sandboxFsRoot, sandboxCwd, sessionId);

    const provider = makeProvider();
    await provider.sessionStorage.captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId,
      handle,
    });

    const hostDir = join(
      hostSessionsDir,
      kimiWorkDirKeyForRealPath(realpathSync(hostCwd)),
      sessionId,
    );
    const state = JSON.parse(
      await readFile(join(hostDir, "state.json"), "utf-8"),
    );
    expect(state.workDir).toBe(realpathSync(hostCwd));
    expect(state.agents.main.homedir).toBe(join(hostDir, "agents", "main"));
    expect(state.title).toBe("probe");

    expect(await readFile(join(hostDir, KIMI_MAIN_WIRE_REL), "utf-8")).toBe(
      '{"main":1}\n',
    );
    // subagent wire captured too
    expect(
      await readFile(join(hostDir, "agents", "agent-0", "wire.jsonl"), "utf-8"),
    ).toBe('{"sub":1}\n');
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
    expect(await provider.sessionStorage.readHostSession(hostCwd, sessionId)).toBe(
      '{"main":1}\n',
    );

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

  it("resumeIntoSandbox transfers back with state.json rewritten to the new sandbox cwd", async () => {
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

    const resumedDir = join(
      sandboxFsRoot,
      SANDBOX_SESSIONS,
      kimiWorkDirKeyForRealPath(secondCwd),
      sessionId,
    );
    const state = JSON.parse(
      await readFile(join(resumedDir, "state.json"), "utf-8"),
    );
    expect(state.workDir).toBe(secondCwd);
    expect(state.agents.main.homedir).toBe(
      `/home/agent/.kimi-code/sessions/${kimiWorkDirKeyForRealPath(secondCwd)}/${sessionId}/agents/main`,
    );
    expect(
      await readFile(join(resumedDir, KIMI_MAIN_WIRE_REL), "utf-8"),
    ).toBe('{"main":1}\n');

    // session registered in the sandbox index (same gating as on the host)
    const sandboxIndex = JSON.parse(
      await readFile(
        join(sandboxFsRoot, "/home/agent/.kimi-code/session_index.jsonl"),
        "utf-8",
      ),
    );
    expect(sandboxIndex).toEqual({
      sessionId,
      sessionDir: `${SANDBOX_SESSIONS}/${kimiWorkDirKeyForRealPath(secondCwd)}/${sessionId}`,
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
