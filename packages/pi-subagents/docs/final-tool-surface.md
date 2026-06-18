# pi-subagents public tool surface

This package exposes two groups of tools: managed child-agent runs and saved workflow SOPs.

## Design rule

Child agents produce output. Parent agents judge output.

The public API avoids mandatory acceptance reports, mutation guards, or required structured output. Process failures are reported, but useful child output remains inspectable.

## Managed-agent tools

### `agent_roles`

List or inspect available child-agent roles.

Key inputs:

- `role` — optional role name to inspect.
- `scope` — `user`, `project`, or `both`.
- `includeDisabled` — include disabled roles for diagnostics.

### `agent_models`

List available runtime models. Optional `role` shows role context.

Use canonical `provider/model` ids in `agent_start agents[].runtime.model` when possible.

### `agent_start`

Start one or more child agents.

Core shape:

```json
{
  "agents": [
    {
      "role": "worker",
      "task": "Implement a bounded task and report result.",
      "cwd": "/path/to/project",
      "context": "fork",
      "authority": { "skills": ["diagnose"] },
      "runtime": { "model": "provider/model", "timeoutMs": 1800000 }
    }
  ],
  "placement": "foreground",
  "concurrency": 2,
  "isolation": "shared-workspace",
  "output": { "path": "reports/result.md", "mode": "inline" }
}
```

Supported fields:

- `agents[].role`
- `agents[].task`
- `agents[].cwd`
- `agents[].context`
- `agents[].authority.skills`
- `agents[].authority.extensions`
- `agents[].runtime.model`
- `agents[].runtime.timeoutMs`
- `agents[].runtime.timeoutMinutes`
- top-level `placement`
- top-level `wait`
- top-level `concurrency`
- top-level `isolation`
- top-level `output`

Rules:

- Default placement is foreground/blocking.
- `placement: "background"` or `wait: "none"` starts a durable background run.
- `output` is top-level and shared by all agents in the call. Identical `agents[].output` values are tolerated and promoted for compatibility; mixed per-agent output is rejected.
- Unsupported runtime/context/isolation/authority fields fail before spawning.
- Mixed `fresh`/`fork` context in one multi-agent run is rejected; start separate runs.
- Per-call tool allowlists are not public; configure role tools instead.

### `agent_status`

Inspect active or completed runs.

- Without `index`: root run overview.
- With `index`: child-specific output, status, paths, and recovery hints.

### `agent_send`

Send follow-up input, extra context, blocker answers, or continuation prompts to a run.

Key inputs:

- `id`
- `input`
- `index` for a specific child in a multi-child run
- `purpose` label

### `agent_stop`

Soft-stop a run with a required reason.

## Workflow tools

### `workflow_list`

List saved workflows and recent runs.

### `workflow_show`

Show a workflow definition before running it.

### `workflow_start`

Start a saved workflow. Default placement is background; use foreground when the caller wants to attach.

### `workflow_status`

Inspect workflow run status, checkpoints, inbox state, and output paths.

### `workflow_send`

Send input to a workflow inbox.

### `workflow_stop`

Stop a workflow run with a required reason.

## Result model

A run result contains process status plus child output/artifacts. A process failure may make the run `failed` or `partial`, but missing validation/reporting metadata does not hide child output.
