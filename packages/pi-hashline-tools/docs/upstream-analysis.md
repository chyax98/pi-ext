# Hashline Package Upstream Analysis

Date: 2026-06-17

Analyzed repositories:

| Repository | Snapshot | Issue state |
| --- | --- | --- |
| `YuGiMob/pi-hashline-edit-pro` | `801421e` from 2026-06-16 | Issues enabled, no issues returned |
| `JerryAZR/pi-hashline-edit` | `e4cac15` from 2026-06-17 | Issues disabled |
| `coctostan/pi-hashline-readmap` | `999c525` from 2026-06-01 | 17 issues returned: 3 open, 14 closed |

## What Each Repo Does

### `pi-hashline-edit-pro`

- Replaces Pi `read` and `edit`.
- Uses strict hash-only anchors in `HASH|content` style, with no line number in the model-facing anchor.
- Uses 4-character URL-safe base64 hashes and occurrence-aware hashing to reduce duplicate-line collisions.
- Rejects legacy `oldText`/`newText` edit shapes and rejects copied hash prefixes in patch content.
- Adds auto-read after `write` so newly written files immediately have anchors.
- Keeps edit diffs in `details.diff` instead of spending model context on the full diff.

Value: strongest "do not silently edit the wrong place" posture. The 4-char occurrence-aware hash is worth considering if we ever redesign the wire format. The downside is that no line number in the visible anchor makes human diagnosis and cross-tool integration weaker than `LINE:HASH`.

### `pi-hashline-edit`

- Replaces `read` and `edit`, with optional extension files for `insert`, `grep`, `undo`, and `/tool-usage`.
- Uses `LINE#HASH|content` anchors and 2-character hex hashes based on line context.
- Splits insertion into a dedicated `insert` tool to reduce optional-field confusion.
- Adds hashline-backed `grep`, so grep output can feed edits directly.
- Adds undo by tracking pre-mutation snapshots through tool events.
- Has a multi-tier stale-anchor strategy: exact match, nearby fuzzy relocation, then snapshot merge.

Value: the split tool design and undo are useful ideas. The silent relocation/merge path is riskier for our use case because the lead called out Pi edit mistakes; correctness should beat convenience for now.

### `pi-hashline-readmap`

- Unified package replacing `read`, `edit`, `grep`, `write`, `ls`, `find`, and `bash`, plus opt-in `ast_search`, `nu`, and a debug context-hygiene tool.
- Uses `LINE:HASH|content` anchors with hash-backed read/search/write output.
- Adds structural maps and direct symbol reads for common languages.
- Adds `replace_symbol` for whole-symbol replacement with syntax-regression validation.
- Adds grep summary/scoping/budget controls and trims large grep outputs.
- Adds bash output compression, original-output recovery, and a final context guard.
- Adds structured `details.ptcValue`, context-hygiene metadata, stale read gating, and public tool policy metadata.
- Already fixed closed issue classes around global hash state under Pi's TS loader, `sg` vs Linux setgid collision, subprocess shell injection, tree-sitter native install failures, grep bloat, and fuzzy replacement truncation.

Value: best base for a maintained internal package because it already consolidates most overlapping tools and has the broadest test coverage.

## Issue Analysis

`pi-hashline-edit-pro`: no issues returned.

`pi-hashline-edit`: GitHub issues are disabled, so state cannot be read from the issue tracker. The changelog shows recent focus on undo, split extensions, insert, grep, fuzzy relocation, snapshot merge, and tool-usage telemetry.

`pi-hashline-readmap` open issues:

| Issue | State | Interpretation | Action in this package |
| --- | --- | --- | --- |
| #147 Termux install fails because `@ast-grep/cli` postinstall has no Android binary | Open | Direct dependency makes install brittle on unsupported platforms. Runtime already has PATH fallback, but npm install fails too early. | Moved `@ast-grep/cli` and `nushell` to `optionalDependencies`; missing bundled binaries fall back to PATH. |
| #146 Bash ignores configured `shellPath` | Open | Wrapped bash creates a fresh built-in tool without Pi's shell setting, hurting Windows/non-standard Git Bash installs. | Added `shellPath` setting and `PI_HASHLINE_SHELL_PATH`, then pass it to `createBashTool`. |
| #145 Some models stringify `edits` arrays | Open | Schema rejects before execution, causing repeated model failures. | Expanded schema to accept stringified arrays and normalize them with a warning. |

Important closed issue classes to preserve:

- #143/#137 global hash initialization and import-specifier duplication: keep hash state on `globalThis`.
- #141 tool conflicts: prefer one coordinated package rather than stacking packages that register the same tool names.
- #126/#124 edit usability: show useful edit summaries/diffs and avoid first-edit confusion.
- #116 subprocess mapper shell injection: keep `execFile`/argument-array subprocess usage.
- #112 `sg` binary collision: prefer bundled `@ast-grep/cli`, then `ast-grep` on PATH, not bare `sg`.
- #89 fuzzy replacement truncation: exact-only replace by default; fuzzy must stay limited and explicit.
- #56/#30 grep/bash context budgets: preserve hard visible-output budgets and avoid oversized structured details.

## Recommended Built-In Capability Set

Ship as one package rather than three overlapping packages:

- `read`: hashline output, image passthrough, symbol reads, structural maps.
- `edit`: anchored edits, exact replace fallback, `replace_symbol`, read-before-edit guard, post-write verification, syntax-regression warnings.
- `write`: safer full-file write with immediate anchors for follow-up edits.
- `grep`: hashline-backed results, summary mode, symbol scope, line/byte budgets.
- `ast_search`: structural code search with PATH fallback when bundled ast-grep is unavailable.
- `ls` and `find`: agent-oriented file exploration to reduce bash misuse.
- `bash`: wrapped built-in bash with output compression and recoverable context guard.
- Optional later: `undo` and `/tool-usage` from `pi-hashline-edit`; both are valuable but should be added after the core package is stable.

Avoid for now:

- Silent fuzzy anchor relocation and snapshot merge from `pi-hashline-edit`. They improve convenience but can hide wrong-target edits. Keep stale/mismatch failures loud unless the user explicitly requests fuzzy mode.
- A second `insert` tool before we have evidence the unified `edit` variants are still confusing in our model mix.

## Local Maintenance Decisions

- Package name: `pi-hashline-tools`.
- Do not configure it in `~/.pi/agent/settings.json` yet.
- Keep upstream settings path compatibility with `hashline-readmap` for now to minimize test and user migration churn.
- Track our divergences in this document and the top of `README.md`.
- Before enabling by default, run it in local Pi sessions against repositories with known edit/grep failure cases and compare against stock Pi tools.
