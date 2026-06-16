# pi-tmux-process-manager design

## Purpose

A minimal tmux-backed process manager for Pi.

It is **not** a subagent system. It only manages long-running commands such as dev servers, watchers, mock APIs, log tails, and eval runners.

## Tool surface

One exposed tool:

```text
tmux_process
```

All behavior is selected by parameters:

```ts
tmux_process({
  action: "run" | "list" | "logs" | "stop",
  processes: [{ name: string, command?: string, cwd?: string }]
})
```

Design rules:

1. If a branch can be expressed as a parameter, do not expose it as a separate tool.
2. Single and multiple processes use the same `processes` array shape.
3. `command` is required only for `action: "run"`.

## Actions

### `run`

Starts one or more processes in tmux windows.

Single process:

```ts
tmux_process({
  action: "run",
  processes: [{ name: "web", command: "npm run dev", cwd: "/repo" }]
})
```

Concurrent processes:

```ts
tmux_process({
  action: "run",
  processes: [
    { name: "web", command: "npm run dev", cwd: "/repo" },
    { name: "watch", command: "npm run test -- --watch", cwd: "/repo" }
  ]
})
```

### `list`

Lists tracked processes:

```ts
tmux_process({ action: "list" })
```

### `logs`

Reads recent output:

```ts
tmux_process({ action: "logs", processes: [{ name: "web" }], lines: 80 })
```

### `stop`

Stops the process or closes the window:

```ts
tmux_process({ action: "stop", processes: [{ name: "web" }], stopMode: "process", reason: "restart" })
tmux_process({ action: "stop", processes: [{ name: "web" }], stopMode: "window", reason: "cleanup" })
```

## Lifecycle model

- One tmux session per project cwd hash: `pi-proc-<hash>`
- One tmux window per process name
- Logs are persisted under `~/.pi/tmux-process-manager/<cwdHash>/logs/`
- State is persisted under `~/.pi/tmux-process-manager/<cwdHash>/state.json`
- Process windows stay open after process exit so logs remain inspectable

## Non-goals

- No agent delegation
- No role management
- No broker protocol
- No worktree/sandbox orchestration
- No replacement for `pi-subagents`
