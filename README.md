# piext

[Pi](https://github.com/earendil-works/pi) extension monorepo.

- **Project path:** clone to any local directory.
- **Workspace layout:** one npm workspace root with extension packages under `packages/`.

给 coding agent 看的约定见 **[AGENTS.md](./AGENTS.md)**。

## 包一览

| 目录 | 作用 |
|------|------|
| `packages/pi-subagents` | 托管子 agent、`agent_*` / `workflow_*` 工具 |
| `packages/pi-openviking` | OpenViking 记忆检索/写入、`mem*` 工具 |
| `packages/pi-tmux-process-manager` | tmux 长驻进程、`tmux_process` 工具 |

## Local Pi wiring

For local development, add each package directory to Pi's local extension settings, using absolute paths from your own clone:

```text
<repo>/packages/pi-subagents
<repo>/packages/pi-openviking
<repo>/packages/pi-tmux-process-manager
```

After changing code, restart Pi or use `/reload` when supported.

## 开发

```bash
cd <repo>
npm install
npm test
```

## 以后发 npm

在对应 `packages/<name>` 发版后：

```bash
pi remove <repo>/packages/<name>
pi install npm:<scope>/<name>
```

未写 `@version` 时可用 `pi update --extensions` 跟进新版本。

## 仓库结构

```text
<repo>/                 # this repository
    AGENTS.md
    README.md
    package.json
    packages/
      pi-subagents/
      pi-openviking/
      pi-tmux-process-manager/
```