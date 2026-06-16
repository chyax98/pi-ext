---
description: Managed-agent bugfix workflow — reproduce, diagnose, fix, validate
argument-hint: <bug report>
---
Fix this bug using managed child Agents where useful: $ARGUMENTS

Required path:
1. Reproduce or identify the failing behavior before changing code.
2. Use `scout` for code/context discovery if the relevant area is unclear.
3. Use `worker` for the smallest correct fix.
4. Use `reviewer` to validate the fix and regression coverage.
5. Prefer concrete verification commands over prose claims.

Use `agent_models`, `agent_start`, `agent_status`, `agent_send`, and `agent_stop` for child-agent work. Prefer foreground/blocking child runs when your next step depends on their result; use background only for independent work, and do not poll status just to wait.

Final answer: root cause, fix, validation, residual risks.
