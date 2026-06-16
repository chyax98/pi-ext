# Managed-agent result resilience

Status: current design notes.

## North star

Managed child agents are result producers. The parent Agent owns judgement.

The runtime should preserve child output, artifacts, session paths, and process status. It should not reject useful child results because a child omitted a report, skipped tests, returned prose only, or failed to match a parent-side validation format.

## Failure visibility

For every terminal, paused, interrupted, or stale child, expose enough evidence for the parent Agent to decide next steps:

- lifecycle state (`completed`, `failed`, `paused`, `detached`, `stale`)
- child textual output, including empty-output markers
- output artifact path when available
- session JSONL path when available
- events/status paths for async runs
- last useful output tail
- recent tool calls and tool failures when available
- model attempt information when fallback/retry occurred
- recovery commands such as `agent_status({ id, index })` or `agent_send({ id, index, input })`

## Child-scoped inspection

`agent_status({ id })` gives a root overview.

`agent_status({ id, index })` gives child-scoped forensics:

```text
Child 2/6: worker failed
Reason: provider error after partial output
Output: /tmp/.../output-1.log
Session: /tmp/.../session.jsonl

Last output tail:
...

Suggested recovery:
agent_send({ id: "...", index: 1, input: "Continue from the last saved output and report current state." })
```

## Structured output policy

Structured output is optional capture metadata.

If a step has `outputSchema` and the child calls `structured_output` with valid JSON, the parent records it for dynamic fanout, named outputs, or downstream automation.

If the child returns prose only, emits invalid JSON, or skips the structured tool, the prose result remains valid. The parent may decide that the result is insufficient, but the runtime must not hide or reject the child output.

## Model discovery and resolution

The model-selection path should preserve intent:

1. Exact canonical match: `provider/model`.
2. Exact bare model id when unique.
3. Preferred provider only as a tie-breaker among exact bare matches.
4. Variant/fuzzy match only when high confidence.
5. Otherwise fail before spawning and show candidates.

No silent fallback should happen for an explicit unresolved model.

## Runtime recovery

Automatic recovery should be limited to cases where continuing is likely safe:

- transient provider/model errors with configured fallback candidates
- process stale repair when existing result/status files are enough to report state
- result watcher retry when delivery is delayed

Parent-visible recovery should be used when semantic judgement is needed:

- partial edits or tool failures
- ambiguous model resolution
- dirty worktree or conflicting file state
- child produced output that may or may not satisfy the request

## Implementation priorities

1. Preserve output/session/artifacts first.
2. Make status inspection cheap and child-scoped.
3. Keep public tool shape small and explicit.
4. Avoid runtime gates that try to grade child usefulness.
5. Let parent Agent decide whether to rerun, continue, or accept result.
