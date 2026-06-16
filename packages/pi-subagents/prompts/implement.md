---
description: Managed-agent implementation workflow — scout context, plan, implement, review
argument-hint: <task>
---
Use the managed-agent extension to implement this task with evidence: $ARGUMENTS

Required path:
1. Call `agent_roles` if you need to confirm role availability. Call `agent_models` before choosing a non-default child model.
2. Start `scout` for focused context when codebase state is unclear.
3. Start `planner` when implementation steps are not obvious.
4. Start `worker` for the concrete implementation.
5. Start `reviewer` for independent validation before final answer.
6. Prefer foreground/blocking child runs when later steps need the child result.
7. Use background placement only when you can continue independent work; after background start, do not poll `agent_status` just to wait—continue useful work or end the turn for completion follow-up.
8. Use `agent_status` / `agent_send` for completed, blocked, warning, or stale background runs.

Use only the current `agent_*` and `workflow_*` tools.

Final answer: changed files, validation commands/results, residual risks.
