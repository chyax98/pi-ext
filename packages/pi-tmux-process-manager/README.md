# pi-tmux-process-manager

一个只负责 **后台进程管理** 的 Pi 扩展。

## Tool surface

只暴露一个工具：

- `tmux_process`

统一数据结构：所有涉及进程的操作都使用 `processes` 数组；单进程也用一元素数组。

```ts
tmux_process({
  action: "run" | "list" | "logs" | "stop",
  processes: [{ name: "web", command: "npm run dev", cwd: "/repo" }]
})
```

设计原则：

> 能作为参数表达的分支，不单独暴露成工具；单个和多个用同一种数据结构。

## Actions

### Run

单进程：

```ts
tmux_process({
  action: "run",
  processes: [{ name: "web", command: "npm run dev", cwd: "/repo" }]
})
```

多进程：

```ts
tmux_process({
  action: "run",
  processes: [
    { name: "web", command: "npm run dev", cwd: "/repo" },
    { name: "watch", command: "npm run test -- --watch", cwd: "/repo" }
  ]
})
```

### List

```ts
tmux_process({ action: "list" })
```

### Logs

```ts
tmux_process({
  action: "logs",
  processes: [{ name: "web" }],
  lines: 80
})
```

### Stop process, keep window/logs

```ts
tmux_process({
  action: "stop",
  processes: [{ name: "web" }],
  stopMode: "process",
  reason: "restart with new env"
})
```

### Close window and cleanup

```ts
tmux_process({
  action: "stop",
  processes: [{ name: "web" }],
  stopMode: "window",
  reason: "cleanup"
})
```

## Boundaries

做：

- tmux 承载后台进程
- 日志读取
- 进程停止与窗口关闭
- 最小状态恢复

不做：

- 子 agent 编排
- broker / supervisor 通信
- sandbox / worktree 隔离
- slash command 终端适配层
