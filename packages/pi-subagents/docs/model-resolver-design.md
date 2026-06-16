# Runtime model resolver design

## Goal

Let parents choose child-agent models without silent surprises.

Explicit model intent must either resolve to a known candidate or fail before spawning. Implicit/default model choice may use normal fallback behavior.

## Inputs

- Requested model string from `agents[].runtime.model`.
- Candidate models from Pi runtime/provider metadata.
- Optional role context, such as role default model or model allowlist.
- Optional current provider preference from the parent runtime.

## Resolution order

1. **Canonical exact**: `provider/model` exactly matches a candidate.
2. **Bare exact**: `model` exactly matches one candidate id.
3. **Preferred-provider tie-break**: bare id matches multiple candidates and the preferred provider has that id.
4. **High-confidence variant/fuzzy**: only for obvious typos or variant names, and only when one candidate is clearly best.
5. **Unresolved**: return structured error with nearby candidates.

## Explicit vs implicit behavior

When `runtime.model` is present, unresolved models fail before spawning. The runtime should not silently fall back to another model.

When `runtime.model` is absent, child startup may use role defaults, parent/current model, or Pi default behavior.

## Error shape

Errors should be actionable:

```text
model_not_available: "claude-sonet"
Close candidates:
- anthropic/claude-sonnet-4
- anthropic/claude-sonnet-4.5
Use agent_models({ role: "worker" }) to inspect available models.
```

## Parent workflow

1. Call `agent_models({ role })` when unsure.
2. Pass canonical `provider/model` in `agent_start` when model choice matters.
3. Treat pre-spawn model errors as configuration errors, not child failures.

## Non-goals

- No semantic judgement of child output.
- No acceptance or reviewer gate.
- No automatic substitution for explicit model choice when confidence is low.
