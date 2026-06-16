# pi-subagents implementation map

## Entry point

- `src/extension/index.ts` registers managed-agent tools, workflow tools, prompt guidance, and shared runtime state.

## Public tool adapters

- `src/extension/agent-tools.ts` — tool definitions and request dispatch for `agent_*` tools.
- `src/extension/workflow-tools.ts` — tool definitions and request dispatch for `workflow_*` tools.
- `src/extension/schemas.ts` — TypeBox schemas for public tool inputs.
- `src/extension/doctor.ts` — runtime diagnostic surface.

## Roles and prompts

- `agents/*.md` — bundled role definitions: delegate, scout, planner, worker, reviewer.
- `prompts/*.md` — parent-facing prompt templates for planning, implementation, review, and bug fixing.
- `src/agents/*` — role loading, overrides, skill/package discovery, and model metadata.

## Foreground runs

- `src/runs/foreground/subagent-executor.ts` — main foreground orchestration.
- `src/runs/foreground/execution.ts` — child process execution and result collection.
- `src/runs/foreground/control.ts` — stop/pause/follow-up control path.
- `src/runs/foreground/result-renderer.ts` — parent-visible summaries.

## Background runs

- `src/runs/background/async-execution.ts` — durable async run creation and lifecycle.
- `src/runs/background/subagent-runner.ts` — child runner process.
- `src/runs/background/run-status.ts` — status persistence and root/child status rendering.
- `src/runs/background/result-watcher.ts` — result delivery and retry.
- `src/runs/background/async-job-tracker.ts` — active job tracking.

## Shared runtime pieces

- `src/runs/shared/pi-spawn.ts` — Pi CLI spawn args and env setup.
- `src/runs/shared/context.ts` — fresh/fork context handling.
- `src/runs/shared/model-resolver.ts` — runtime model discovery and resolution.
- `src/runs/shared/structured-output.ts` — optional structured output capture.
- `src/runs/shared/acceptance.ts` — compatibility no-op helpers for legacy data shapes.
- `src/runs/shared/acceptance-verdict.ts` — process-level verdict only; no semantic acceptance gate.
- `src/runs/shared/dynamic-fanout.ts` — fanout input expansion from prior outputs.

## Workflow runtime

- `src/workflow/*` — saved workflow discovery, execution, run status, inbox, and persistence.

## Intercom bridge

- `src/intercom/*` — optional child-to-parent communication bridge when configured.

## Current behavior summary

- Parent starts child agents and receives results.
- Child output is preserved even when prose-only or partial.
- Structured output is optional metadata.
- Missing tests, missing edits, missing reports, or schema mismatch do not reject output.
- Non-zero process exit, timeout, interrupt, stale process, or provider failure are process-level failures and remain visible with output/session paths when available.
