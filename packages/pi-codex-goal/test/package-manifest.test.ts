import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const EXPECTED_CREATE_GOAL_PROMPT = `---
description: Convert a plain task into a strict evidence-based pi-codex goal and create it
argument-hint: "<task>"
---

User task:
$@

Turn the user task into exactly one durable pi-codex-goal objective, then call the goal creation tool with that objective.

Natural-language intent is binding goal-writing input. Recognize wording such as \`激进 20m 完成这个任务\`, \`彻底\`, \`大纵切\`, \`快速推进\`, \`正常模式\`, \`保守一点\`, \`小步来\`, or equivalent expressions. Default broad refactor, audit, migration, and "finish the whole thing" tasks to aggressive vertical-slice execution. Use a normal/careful posture only when the user asks for it in natural language.

This prompt invocation is an explicit user request to set a new goal. When the goal creation tool exposes \`replace_existing\`, pass \`replace_existing: true\` so an existing active, paused, or budget-limited goal is replaced instead of requiring \`/goal clear\` first.

Do not set a token budget limit unless the user explicitly provides a budget/limit in the task. If no explicit budget is provided, omit the token budget field entirely. Budgets are in millions of tokens by default: natural language such as \`20m\`, \`20 m\`, \`预算 20\`, or \`激进 20m 完成这个任务\` means \`token_budget: 20\`, which the tool stores as \`20000000\` tokens. Do not choose a small conservative budget on your own.

The goal must be a completion contract, not a task summary. Preserve the user's full intent. Do not weaken broad acceptance criteria such as "all", "any", "complete", "no tech debt", "do it right", "fully", or "hard acceptance criteria".

The goal must require:

0. Execution posture
   - For broad refactors, migrations, audits, bug batches, or multi-subsystem objectives, require aggressive vertical-slice progress: take ownership of whole workstreams, not tiny comment-only or rename-only fragments.
   - Prefer a small number of large coherent workstreams over many micro-edits. When delegation tools are available, use workers for independent vertical slices and keep the parent focused on merge, conflict resolution, verification, and gap filling.
   - Do not let caution become paralysis. Choose the largest safe next step with rollback/verification, execute it, then verify. Avoid spending multiple turns only planning, restating scope, or making cosmetic cleanups unless the goal itself is planning-only.
   - Local green checks, partial cleanup, or "some progress" are not completion. Keep going until the full objective and final gates are satisfied or a real blocker is proven.
   - If the user asks for normal/careful/small-step execution in natural language, keep this posture bounded and lower-risk, but still require substantive progress toward the full objective.

1. Outcome
   - State what must be true when complete.
   - Preserve the full requested end state.
   - Do not narrow scope after the fact unless the original user task explicitly defined that scope.

2. Verification evidence
   - Name the concrete evidence required before completion.
   - Include relevant tests, lint, type checks, builds, smoke checks, diffs, docs, generated outputs, rendered UI inspection, or artifact checks when applicable.
   - If the repo has an existing local CI/validation command, require it unless clearly irrelevant.

3. Constraints
   - Preserve existing behavior unless the task explicitly changes it.
   - Do not discard user changes.
   - Do not leave unapproved shortcuts, compatibility shims, TODO placeholders, dead code, duplicated logic, hidden assumptions, or undocumented behavior changes.

4. Iteration policy
   - After each attempt, inspect evidence, update the plan, and keep taking the next low-risk useful step.
   - Do not stop at a plan when implementation or verification remains.
   - If validation fails, triage and fix the cause rather than reporting partial completion.
   - Do not spend long sessions making tiny isolated edits while the main workstreams remain untouched. Each iteration should advance a meaningful vertical slice, unblock a final gate, or produce concrete evidence for why progress is blocked.

5. Completion audit
   - Before marking the goal complete, map every explicit requirement in the goal to fresh evidence from files, commands, diffs, tests, screenshots, artifacts, or logs.
   - The goal is not complete if any requirement is unverified, narrowed, deferred, or only probably satisfied.
   - Phrases like "for the scope this is complete", "good enough", "out of scope", or "remaining tech debt" are not valid completion evidence unless the original user task explicitly allowed that limitation.

6. Blocked stop condition
   - If completion is impossible with current access, tools, budget, or missing decisions, stop without marking complete.
   - Report attempted paths, evidence gathered, exact blockers, remaining unmet requirements, and what input would unblock progress.

Use concise imperative language in the goal. If the task is blank or only whitespace, infer the goal based on the conversation context or ask the user to clarify.
`;

test("package exposes the create-goal prompt template", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    files?: string[];
    pi?: { prompts?: string[] };
  };

  assert.ok(packageJson.files?.includes("prompts"));
  assert.ok(packageJson.pi?.prompts?.includes("./prompts"));

  const prompt = readFileSync("prompts/create-goal.md", "utf8");
  assert.equal(prompt, EXPECTED_CREATE_GOAL_PROMPT);
});
