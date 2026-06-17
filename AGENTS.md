# AGENTS.md — piext

Instructions for humans and coding agents working in this monorepo.

## What this repo is

- **Location:** clone to any local directory; examples below use `<repo>` for the repository root.
- **Purpose:** Develop and version **Pi coding-agent extensions** as independent `pi-package` npm workspaces.
- **Runtime wiring:** Pi local extension settings should point at package directories under `packages/`; use absolute paths from your own clone.

## Layout

```text
piext/
  package.json          # npm workspaces root
  packages/
    pi-subagents/       # managed child agents, workflows (has unit + integration tests)
    pi-openviking/      # OpenViking mem* tools, recall, session sync
    pi-tmux-process-manager/  # tmux_process tool, skill under src/skills/
    pi-codex-goal/      # Codex-style /goal tracking, continuation, completion audit
    pi-mcp-adapter/    # MCP gateway / direct tools / OAuth adapter, local maintained version
    pi-hashline-tools/ # XD-maintained merged hashline read/edit/grep/write/ls/find/ast_search/bash package
```

Do not treat `~/.pi/agent/extensions/` as the source of truth; canonical code lives here.

## Commands

From repo root:

```bash
cd <repo>
npm install
npm test    # all workspaces with tests
npm run check   # lint/typecheck where defined
```

Per package (example):

```bash
cd packages/pi-subagents && npm run test:unit
cd packages/pi-tmux-process-manager && npm run test:unit
cd packages/pi-codex-goal && npm run verify
cd packages/pi-hashline-tools && npm test
```

After changing extension entrypoints or `package.json` `pi` manifest: **restart Pi** or use `/reload` when supported. `pi-hashline-tools` is currently maintained in-repo but should not be added to user-local Pi settings until it is explicitly stabilized.

## Pi package rules

Each publishable package should have:

- `"keywords": ["pi-package", ...]`
- `"pi": { "extensions": ["./path/to/entry.ts"], ... }` (optional `skills`, `prompts`)
- Pi core deps in `peerDependencies` (`@earendil-works/pi-coding-agent`, etc.), not bundled

Official reference: `@earendil-works/pi-coding-agent` docs `packages.md` / `extensions.md`.

## Local install vs npm

| Mode | settings.json | Upgrade |
|------|----------------|---------|
| Dev (current) | `<repo>/packages/<pkg>` absolute path in local Pi settings | edit + restart Pi |
| Published | `npm:@scope/<pkg>` or `npm:<pkg>` | `pi update --extensions` |
| Pinned npm | `npm:pkg@1.2.3` | manual reinstall with new version |

Switch dev → npm: `pi remove <absolute-path>` then `pi install npm:...`.

## Agent workflow expectations

1. **Scope:** Change only the package(s) relevant to the task; avoid drive-by refactors across workspaces.
2. **Verify:** Run tests in the touched package before claiming done (`pi-subagents`, `pi-tmux-process-manager`, `pi-codex-goal`, and `pi-mcp-adapter` have automated tests).
3. **Settings:** Do not commit secrets; `~/.pi/agent/settings.json` is user-local — document path changes in README/AGENTS, do not copy full settings into the repo.
4. **New package:** Add under `packages/`, wire `pi` manifest, add to local Pi settings with the package directory path.
5. **Docs:** User-facing Pi behavior notes for extensions stay in each package `README.md`; repo-wide conventions stay here and in root `README.md`.
