# pi-subagents

Pi extension for managed child-agent runs and workflow SOPs.

## Product model

A parent Pi session sends prompts to child Pi agents. Child agents produce results. The parent decides whether the result is useful.

The runtime is a result collector and process supervisor. It does not grade child work with mandatory acceptance reports, reviewer gates, mutation guards, or required structured output.

## Public tools

### Managed agents

- `agent_roles` — list available child-agent roles.
- `agent_models` — list available runtime models for a role.
- `agent_start` — start one or more child agents.
- `agent_status` — inspect running or completed child runs.
- `agent_send` — send follow-up input to a child run.
- `agent_stop` — soft-stop a child run.

### Workflows

- `workflow_list` — list saved workflow SOPs and recent runs.
- `workflow_show` — inspect a saved workflow definition.
- `workflow_start` — start a saved workflow.
- `workflow_status` — inspect workflow state.
- `workflow_send` — send input to a running workflow inbox.
- `workflow_stop` — stop a workflow run.

## Roles

Bundled roles:

- `delegate` — lightweight general-purpose child.
- `scout` — read-only reconnaissance.
- `planner` — plan only.
- `worker` — bounded implementation task.
- `reviewer` — independent review/validation.

Roles are normal Pi agent definitions under `agents/` and can be overridden by user/project config.

## `agent_start` examples

Single foreground child:

```json
{
  "agents": [
    {
      "role": "worker",
      "task": "Implement the accepted plan and report what changed.",
      "context": "fork",
      "runtime": { "timeoutMs": 1800000 }
    }
  ]
}
```

Parallel background scouts:

```json
{
  "agents": [
    { "role": "scout", "task": "Inspect auth flow." },
    { "role": "scout", "task": "Inspect persistence layer." }
  ],
  "placement": "background"
}
```

Follow up to a completed or live child:

```json
{
  "id": "run-id-or-prefix",
  "index": 0,
  "input": "Continue from your last output and summarize remaining risks."
}
```

## Result semantics

Child output is preserved even when it is prose-only, partial, or empty.

The runtime may report process-level failures such as non-zero exit, provider error, timeout, interrupt, or hidden tool failure. It does not fail a child merely because:

- no test was added,
- no file was edited,
- no structured report was emitted,
- no reviewer result exists,
- no `structured_output` call was made,
- structured output failed schema validation.

If a child produced a result, the parent can inspect that result and decide whether to rerun, continue, accept, or ask for clarification.

## Structured output

`outputSchema` is optional capture metadata. If a child calls `structured_output` with valid data, the parent records it for named outputs and dynamic fanout. If the child returns prose only or invalid structured data, the prose output remains valid.

## Context and isolation

- `context: "fresh"` starts from a clean context.
- `context: "fork"` branches from the parent session when supported.
- `isolation: "git-worktree"` can isolate parallel implementation work in separate worktrees.

## Background runs

Background runs write status/result files and can be inspected later with `agent_status`. Use background placement only when the parent can continue independently or the user wants a detached run.

## Workflows

Saved workflows are SOP scripts stored outside the package and executed by the workflow tools. They can coordinate child agents, persist checkpoints, and receive inbox messages through `workflow_send`.

## Development

```bash
npm run test:unit
npm run test:integration
npm run test:all
```

Package entrypoint: `src/extension/index.ts`.

Public docs:

- `docs/final-tool-surface.md`
- `docs/current-implementation-map.md`