# pi-tmux-process-manager decisions

## Decision: one tool, action-parameter API

Expose only:

```text
tmux_process
```

Do not expose separate tools for run/list/logs/kill. Those operations are parameterized actions:

- `action: "run"`
- `action: "list"`
- `action: "logs"`
- `action: "stop"`

Reason: this extension is system-level. A large tool surface increases model choice burden and makes unrelated tasks more likely to touch tmux. The agent should see one background-process primitive, not a small tmux API suite.

## Decision: one data shape for one or many processes

Use only:

```ts
processes: [{ name: string, command?: string, cwd?: string }]
```

Single process:

```ts
processes: [{ name: "web", command: "npm run dev" }]
```

Multiple processes:

```ts
processes: [
  { name: "web", command: "npm run dev" },
  { name: "watch", command: "npm run test -- --watch" }
]
```

Reason: separate `name + command` and `processes` shapes increase cognitive burden. One shape is easier for both humans and agents.

## Decision: process manager, not agent orchestrator

The extension only runs background commands. It does not manage subagents, worktrees, roles, broker protocols, or supervisor/worker conversations.

Reason: `pi-subagents` already owns agent orchestration. This package owns background process lifecycle.

## Decision: stop has two modes

`action: "stop"` supports:

- `stopMode: "process"` — terminate command, keep window/logs
- `stopMode: "window"` — close window and clean tracked state

Reason: debugging often needs logs after a process stops. Cleanup should be explicit.
