# Changelog

## Unreleased

### Added
- Pi-native managed-agent tools: `agent_roles`, `agent_models`, `agent_start`, `agent_status`, `agent_send`, and `agent_stop`.
- Foreground workflow SOP tools: `workflow_list`, `workflow_show`, `workflow_start`, `workflow_status`, `workflow_send`, and `workflow_stop`.
- Bundled roles: `delegate`, `scout`, `planner`, `worker`, and `reviewer`.
- Bundled prompt templates: `plan`, `implement`, `fix-bug`, and `review`.
- Bundled workflow SOPs: `implementation` and `review`.
- Native extension prompt guidance through Pi `before_agent_start` plus bundled package prompt resources.
- Workflow inbox support through `workflow_send`, `inbox.read(lastSeq)`, and `inbox.wait(lastSeq, options)`.

### Changed
- Child-agent results are preserved by default; acceptance/report/mutation/structured-output checks are no longer hard gates.
- Public surface is action-level managed-agent/workflow tools only.
- Package ships runtime source, roles, prompts, bundled workflows, README, changelog, and concise public docs.
- Unsupported public semantics fail loudly instead of being ignored.

### Fixed
- Unacknowledged grouped async intercom result files are retained and retried before completion is marked delivered.
- Terminal async root jobs schedule cleanup even when nested refresh fails and no live nested children are known.
- Workflow run listing ignores non-directory entries in the runs directory.
- Nested async resume cwd resolves from nested status metadata.
