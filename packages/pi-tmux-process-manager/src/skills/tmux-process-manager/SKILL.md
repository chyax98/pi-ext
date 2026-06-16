---
name: tmux-process-manager
description: >-
  Manage long-running background processes in tmux. Use when the user wants to
  start one or more dev servers, watchers, mock APIs, log tails, or other
  background commands; inspect logs; list tracked processes; stop a process; or
  close its tmux window.
---

# tmux-process-manager

Use this skill for **background processes**, not child agents.

## Tool

Only one tool is exposed:

```ts
tmux_process(params)
```

Use one shape for single and multiple processes:

```ts
processes: [{ name: string, command?: string, cwd?: string }]
```

Use `action` to select behavior:

- `action: "run"` — start one or more long-running commands; each process requires `command`
- `action: "list"` — list tracked processes; no `processes` needed
- `action: "logs"` — read recent output; each process only needs `name`
- `action: "stop"` — stop the process or close the tmux window; each process only needs `name`

## Examples

Start one process:

```ts
tmux_process({
  action: "run",
  processes: [{ name: "web", command: "npm run dev", cwd: "/repo" }]
})
```

Start multiple processes concurrently:

```ts
tmux_process({
  action: "run",
  processes: [
    { name: "web", command: "npm run dev", cwd: "/repo" },
    { name: "watch", command: "npm run test -- --watch", cwd: "/repo" }
  ]
})
```

List tracked processes:

```ts
tmux_process({ action: "list" })
```

Read logs:

```ts
tmux_process({ action: "logs", processes: [{ name: "web" }], lines: 80 })
```

Stop process but keep window/logs:

```ts
tmux_process({ action: "stop", processes: [{ name: "web" }], stopMode: "process", reason: "restart" })
```

Close window and clean state:

```ts
tmux_process({ action: "stop", processes: [{ name: "web" }], stopMode: "window", reason: "cleanup" })
```

## Guidance

- Prefer stable names like `web`, `api`, `worker`, `logs`.
- Do not add `&` to commands; let tmux manage lifecycle.
- Use one `processes` array for one or many items.
- Read logs before terminating unless the user explicitly wants immediate stop.
- Use `stopMode: "process"` when output should remain inspectable.
- Use `stopMode: "window"` for full cleanup.
