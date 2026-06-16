# pi-codex-goal — agent notes

Pi extension: Codex-style `/goal` command and `get_goal` / `create_goal` / `update_goal` tools. State lives in pi session custom entries.

## Local pi install policy

In this monorepo, the canonical source is:

```text
packages/pi-codex-goal
```

The active Pi install should point at this package directory, normally as a user/global package:

```sh
pi install /Users/xd/p/piext/packages/pi-codex-goal
```

Do not install a second npm/GitHub copy of this package alongside the local checkout. Duplicate installs both register `get_goal`, `create_goal`, and `update_goal`, causing tool-registration conflicts. If conflicts appear, inspect `pi list` and remove the npm/GitHub duplicate or extra project-local entry so only this local checkout remains active.

## Verify before finishing

```sh
npm run verify
```

Runs `tsc --noEmit`, the platform-smoke harness checks, and the full Node test suite (`test/*.test.ts`).

For release-sensitive changes, also use the local Crabbox platform gate documented in `docs/platform-smoke.md`:

```sh
npm run check:platform-smoke
npm run smoke:platform:all
```

`smoke:platform:all` runs `smoke:platform:doctor` before any target suite starts.

The required gate runs the full suite plus a real model-backed goal-tool smoke on macOS, Ubuntu Linux, and native Windows. The default smoke model is `zai/glm-5.2`; override with `PLATFORM_SMOKE_MODEL` when needed.

## Layout

| Area | Modules |
|------|---------|
| Wiring | `src/index.ts`, `goal-runtime-controller.ts` |
| User / model API | `commands.ts`, `tools.ts`, `prompts.ts`, `format.ts`, `prompts/create-goal.md` |
| Runtime events | `goal-runtime-event-handlers.ts`, `goal-runtime-*-handlers.ts` |
| Transitions | `goal-transition.ts`, `goal-transition-effects.ts`, `goal-state-controller.ts` |
| Stale continuations | `stale-queued-work-*.ts` |
| Recovery | `recovery*.ts` |
| Domain | `state.ts`, `types.ts`, `goal-persistence.ts` |

Current structural audit and remediation record: `docs/CODEBASE_AUDIT.md`.
