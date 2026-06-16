---
description: Managed-agent planning workflow — gather context and produce an implementation plan
argument-hint: <request>
---
Create an implementation plan for: $ARGUMENTS

Use `scout` for context when needed, then `planner` for the plan. Prefer foreground/blocking when the planner/scout result is required before you can continue. Use background only for independent work, and do not poll status just to wait. Do not edit code unless the user explicitly asks for implementation after the plan.

The plan should include files to inspect/modify, ordered steps, validation signals, risks, and open questions.

Use only the current `agent_*` and `workflow_*` tools.
