import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalToolResponse, toToolText, type GoalToolResponse } from "./format.js";
import { createGoal, replaceGoal } from "./state.js";
import { TOOL_PROMPT_GUIDELINES } from "./prompts.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

const EmptyParams = Type.Object({});

const TokenBudgetParam = Type.Unsafe({
  anyOf: [
    { type: "number", exclusiveMinimum: 0 },
    { type: "string", minLength: 1 },
  ],
  description:
    "Optional token budget in millions of tokens. Only set this when the user explicitly provides a budget/limit. Values like 2 or '2m' mean 2,000,000 tokens.",
});

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue until completion.",
  }),
  token_budget: Type.Optional(TokenBudgetParam),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        "Replace an existing non-complete goal. Use only when the user explicitly asks to set a new goal over the current one.",
    }),
  ),
});

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete"] as const, {
    description: "Only complete is accepted. Do not call this until no required work remains.",
  }),
});

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionBudgetReport = false,
): AgentToolResult<GoalToolResponse & { error: string | null }> {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null },
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

function parseTokenBudget(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return value as null | undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value * 1_000_000) : Number.NaN;
  }
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const normalized = value.trim().toLowerCase().replaceAll("_", "").replace(/\s+/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)m?$/);
  if (!match) {
    return Number.NaN;
  }
  const numeric = Number(match[1]);
  const budget = numeric * 1_000_000;
  return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : Number.NaN;
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current Codex-style goal and usage for this pi session.",
    promptSnippet: "Inspect the current goal, status, token budget, tokens used, and active elapsed time.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const goal = host.getGoal();
      return textResult(toToolText(goal), goal);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a Codex-style long-running goal for this pi session.",
    promptSnippet:
      "Create one goal with an objective and optional positive token budget. Fails when a non-complete goal already exists unless replace_existing is true; replaces a completed goal.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsedTokenBudget = parseTokenBudget(params.token_budget);
      if (Number.isNaN(parsedTokenBudget)) {
        throwToolError("Token budget must be a positive number of millions, such as 2 or 2m. Only set token_budget when the user explicitly provides a budget/limit.");
      }
      const current = host.getGoal();
      const shouldReplaceExisting = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = shouldReplaceExisting
        ? replaceGoal(params.objective, parsedTokenBudget ?? null)
        : createGoal(current, params.objective, parsedTokenBudget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the current Codex-style goal complete only after the objective is actually achieved and no required work remains. Do not use this tool just because work is stopping, budget is low, or partial progress looks sufficient.",
    promptSnippet: "Mark the current goal complete only after an evidence-backed completion audit proves no required work remains.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = host.completeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      return textResult(toToolText(result.goal, true), result.goal, true);
    },
  });
}
