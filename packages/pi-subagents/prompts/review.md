---
description: Managed-agent review workflow — independent review with evidence
argument-hint: <target>
---
Review this target using the managed-agent extension: $ARGUMENTS

Use `reviewer` as the primary child role. If context is too broad, start `scout` first. Prefer foreground/blocking if you need the review result before continuing. Use background placement only when the review can run while you inspect related material; do not poll status just to wait.

Review output should separate blockers, non-blocking notes, and verified-correct areas. Cite files, commands, or artifacts.

Use only the current `agent_*` and `workflow_*` tools.
