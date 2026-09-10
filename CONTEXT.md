# sandcastle-agent-kimi

A Sandcastle agent provider that runs agentic iterations through the Kimi Code CLI, moving session state between the host and sandbox filesystems.

## Language

**Session Capture**:
Copying a session's persisted state from the sandbox back to the host after a run, so the session outlives the sandbox.
_Avoid_: export, snapshot

**Session Resume**:
Starting a new run that continues an existing session; the session state is transferred into the run's environment and repointed at that environment's paths.
_Avoid_: restart, continue

**Session Fork**:
Creating an independent copy of a session under a fresh id and resuming the copy. A fork does not inherit Pending Goals (ADR 0001).
_Avoid_: branch, clone

**Pending Goals**:
The goals a session has accepted but not yet completed. Preserved across capture and resume; dropped on fork.

**Session Index**:
The registry at `$KIMI_CODE_HOME/session_index.jsonl` mapping sessionId → sessionDir + workDir; maintained independently on the host and inside each sandbox.
_Avoid_: session list, session catalog

**workDir Bucket**:
The per-working-directory namespace under which kimi stores a project's sessions, keyed by the directory's realpath.
_Avoid_: project dir, workspace folder

**Runtime Binding**:
The `runtime.set_binding` record in a session's wire.jsonl that binds the session to a workDir Bucket; kimi refuses to resume a session whose binding does not match the current workspace.

**Workspace**:
A working directory as registered in kimi's `workspaces.json`, keyed by its workDir Bucket.

**Ensure-Local Relocation**:
The exec-time move of a session into the current cwd's workDir Bucket (state cwd + agent homedirs + Runtime Bindings + Session Index) performed before every resume/fork; a no-op when the session is already local (ADR 0002).
_Avoid_: migration, move
