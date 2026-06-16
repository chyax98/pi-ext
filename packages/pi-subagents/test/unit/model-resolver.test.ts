import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterCandidateModels, resolveRequestedModel } from "../../src/runs/shared/model-resolver.ts";
import type { ModelInfo } from "../../src/shared/model-info.ts";

const models: ModelInfo[] = [
	{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
	{ provider: "azure", id: "gpt-5", fullId: "azure/gpt-5" },
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	{ provider: "local", id: "custom-model", fullId: "local/custom-model" },
];

describe("filterCandidateModels", () => {
	it("restricts candidates by canonical or bare role allowlist", () => {
		assert.deepEqual(
			filterCandidateModels(models, ["anthropic/claude-sonnet-4", "custom-model"]).map((model) => model.fullId),
			["anthropic/claude-sonnet-4", "local/custom-model"],
		);
	});
});

describe("resolveRequestedModel", () => {
	it("returns none for missing requests", () => {
		const result = resolveRequestedModel({ requested: undefined, available: models });
		assert.deepEqual(result, { ok: true, kind: "none", confidence: "exact" });
	});

	it("resolves canonical exact models", () => {
		const result = resolveRequestedModel({ requested: "anthropic/claude-sonnet-4", available: models });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.kind, "exact-canonical");
			assert.equal(result.resolved, "anthropic/claude-sonnet-4");
		}
	});

	it("resolves bare exact models with preferred provider", () => {
		const result = resolveRequestedModel({ requested: "gpt-5", available: models, preferredProvider: "azure" });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.kind, "exact-bare-provider-preferred");
			assert.equal(result.resolved, "azure/gpt-5");
		}
	});

	it("resolves bare exact provider ties with injected rng", () => {
		const result = resolveRequestedModel({ requested: "gpt-5", available: models, rng: () => 0.75 });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.kind, "exact-bare");
			assert.equal(result.resolved, "azure/gpt-5");
			assert.match(result.note ?? "", /among 2 providers/);
		}
	});

	it("matches variants only after exact matching fails", () => {
		const result = resolveRequestedModel({ requested: "gpt-5", available: [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" }] });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.kind, "variant");
			assert.equal(result.resolved, "openai/gpt-5-mini");
		}
	});

	it("does not variant-match short low-signal requests", () => {
		const result = resolveRequestedModel({ requested: "pro", available: [{ provider: "x", id: "pro-mini", fullId: "x/pro-mini" }] });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "below-confidence-threshold");
	});

	it("resolves high-confidence fuzzy typos", () => {
		const result = resolveRequestedModel({ requested: "claude-sonet-4", available: models });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.kind, "fuzzy");
			assert.equal(result.resolved, "anthropic/claude-sonnet-4");
		}
	});

	it("fails explicit unknown models instead of falling back", () => {
		const result = resolveRequestedModel({ requested: "totally-unknown-model", available: models });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "below-confidence-threshold");
			assert.match(result.message, /could not be resolved/);
		}
	});

	it("keeps known thinking suffixes on resolved models", () => {
		const result = resolveRequestedModel({ requested: "custom-model:high", available: models });
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.resolved, "local/custom-model:high");
	});

	it("fails provider-scoped requests with provider candidates", () => {
		const result = resolveRequestedModel({ requested: "openai/not-real", available: models });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.reason, "not-found");
			assert.deepEqual(result.candidates, ["openai/gpt-5", "openai/gpt-5-mini"]);
		}
	});
});
