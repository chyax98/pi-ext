import { splitKnownThinkingSuffix, type ModelInfo } from "../../shared/model-info.ts";

export interface ResolveRequestedModelInput {
	requested: string | undefined;
	available: ModelInfo[];
	preferredProvider?: string;
	roleAllowedModels?: string[];
	rng?: () => number;
}

export type ModelResolutionKind =
	| "none"
	| "exact-canonical"
	| "exact-bare"
	| "exact-bare-provider-preferred"
	| "variant"
	| "fuzzy";

export interface ModelResolutionSuccess {
	ok: true;
	kind: ModelResolutionKind;
	requested?: string;
	resolved?: string;
	confidence: "exact" | "high" | "medium";
	note?: string;
	candidatesConsidered?: string[];
}

export interface ModelResolutionFailure {
	ok: false;
	requested: string;
	reason: "no-available-models" | "not-found" | "ambiguous" | "provider-not-available" | "below-confidence-threshold";
	candidates: string[];
	message: string;
}

export type ModelResolution = ModelResolutionSuccess | ModelResolutionFailure;

function normalizeKey(value: string): string {
	return value.trim().toLowerCase();
}

function modelWithSuffix(model: ModelInfo, thinkingSuffix: string): string {
	return `${model.fullId}${thinkingSuffix}`;
}

function asCandidateIds(candidates: ModelInfo[]): string[] {
	return candidates.map((candidate) => candidate.fullId).sort();
}

function roleAllowedSet(roleAllowedModels: string[] | undefined): Set<string> | undefined {
	const filtered = roleAllowedModels?.map((value) => value.trim()).filter(Boolean);
	return filtered?.length ? new Set(filtered) : undefined;
}

export function filterCandidateModels(available: ModelInfo[], roleAllowedModels?: string[]): ModelInfo[] {
	const allowed = roleAllowedSet(roleAllowedModels);
	if (!allowed) return available;
	return available.filter((model) => allowed.has(model.fullId) || allowed.has(model.id));
}

function chooseByProvider(matches: ModelInfo[], preferredProvider: string | undefined, rng: () => number): { model: ModelInfo; preferred: boolean; randomized: boolean } {
	if (preferredProvider) {
		const preferred = matches.find((match) => match.provider === preferredProvider);
		if (preferred) return { model: preferred, preferred: true, randomized: false };
	}
	if (matches.length === 1) return { model: matches[0]!, preferred: false, randomized: false };
	const index = Math.max(0, Math.min(matches.length - 1, Math.floor(rng() * matches.length)));
	return { model: matches[index]!, preferred: false, randomized: true };
}

function providerScopedCandidates(requestedProvider: string, candidates: ModelInfo[]): ModelInfo[] {
	return candidates.filter((candidate) => candidate.provider === requestedProvider);
}

const VARIANT_MIN_LENGTH = 4;
const VARIANT_SEPARATORS = ["-", ".", "_", ":"];

function isVariant(requestedId: string, candidateId: string): boolean {
	if (requestedId.length < VARIANT_MIN_LENGTH) return false;
	const requested = normalizeKey(requestedId);
	const candidate = normalizeKey(candidateId);
	return VARIANT_SEPARATORS.some((separator) => candidate.startsWith(`${requested}${separator}`));
}

function rankVariant(requestedId: string, matches: ModelInfo[], preferredProvider: string | undefined, rng: () => number): ModelInfo {
	const ranked = [...matches].sort((a, b) => {
		const suffixDelta = a.id.length - b.id.length;
		if (suffixDelta !== 0) return suffixDelta;
		const providerDelta = (b.provider === preferredProvider ? 1 : 0) - (a.provider === preferredProvider ? 1 : 0);
		if (providerDelta !== 0) return providerDelta;
		return 0;
	});
	const bestLength = ranked[0]!.id.length;
	const bestPreferred = ranked[0]!.provider === preferredProvider;
	const tied = ranked.filter((candidate) => candidate.id.length === bestLength && (candidate.provider === preferredProvider) === bestPreferred);
	return tied.length === 1 ? tied[0]! : chooseByProvider(tied, preferredProvider, rng).model;
}

function levenshtein(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	const curr = Array.from({ length: b.length + 1 }, () => 0);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		for (let j = 0; j < prev.length; j++) prev[j] = curr[j]!;
	}
	return prev[b.length]!;
}

function fuzzyScore(requested: string, candidate: string): number {
	const a = normalizeKey(requested).replace(/[^a-z0-9]+/g, "");
	const b = normalizeKey(candidate).replace(/[^a-z0-9]+/g, "");
	if (!a || !b) return 0;
	if (a === b) return 1;
	const distance = levenshtein(a, b);
	const base = 1 - distance / Math.max(a.length, b.length);
	const prefixBonus = b.startsWith(a.slice(0, Math.min(4, a.length))) ? 0.04 : 0;
	return Math.max(0, Math.min(1, base + prefixBonus));
}

function formatFailure(requested: string, reason: ModelResolutionFailure["reason"], candidates: string[], detail: string): ModelResolutionFailure {
	return {
		ok: false,
		requested,
		reason,
		candidates,
		message: `${detail}\nAvailable candidates:\n${candidates.length ? candidates.map((candidate) => `- ${candidate}`).join("\n") : "(none)"}`,
	};
}

export function resolveRequestedModel(input: ResolveRequestedModelInput): ModelResolution {
	const requested = input.requested?.trim();
	if (!requested) return { ok: true, kind: "none", confidence: "exact" };

	const candidates = filterCandidateModels(input.available, input.roleAllowedModels);
	const candidateIds = asCandidateIds(candidates);
	if (candidates.length === 0) return formatFailure(requested, "no-available-models", [], `No available models can satisfy requested model '${requested}'.`);

	const rng = input.rng ?? Math.random;
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(requested);
	const baseKey = normalizeKey(baseModel);

	if (baseModel.includes("/")) {
		const exact = candidates.find((candidate) => candidate.fullId === baseModel) ?? candidates.find((candidate) => normalizeKey(candidate.fullId) === baseKey);
		if (exact) {
			return { ok: true, kind: "exact-canonical", requested, resolved: modelWithSuffix(exact, thinkingSuffix), confidence: "exact" };
		}
		const [requestedProvider] = baseModel.split("/", 1);
		const scoped = requestedProvider ? providerScopedCandidates(requestedProvider, candidates) : [];
		return formatFailure(
			requested,
			scoped.length ? "not-found" : "provider-not-available",
			scoped.length ? asCandidateIds(scoped) : candidateIds,
			`Requested model '${requested}' is not available${scoped.length ? ` for provider '${requestedProvider}'` : ""}.`,
		);
	}

	const bareExact = candidates.filter((candidate) => candidate.id === baseModel || normalizeKey(candidate.id) === baseKey);
	if (bareExact.length > 0) {
		const choice = chooseByProvider(bareExact, input.preferredProvider, rng);
		return {
			ok: true,
			kind: choice.preferred ? "exact-bare-provider-preferred" : "exact-bare",
			requested,
			resolved: modelWithSuffix(choice.model, thinkingSuffix),
			confidence: "exact",
			note: choice.randomized ? `Resolved bare model '${requested}' to '${choice.model.fullId}' among ${bareExact.length} providers.` : undefined,
			candidatesConsidered: asCandidateIds(bareExact),
		};
	}

	const variants = candidates.filter((candidate) => isVariant(baseModel, candidate.id));
	if (variants.length > 0) {
		const chosen = rankVariant(baseModel, variants, input.preferredProvider, rng);
		return {
			ok: true,
			kind: "variant",
			requested,
			resolved: modelWithSuffix(chosen, thinkingSuffix),
			confidence: "high",
			note: `Resolved '${requested}' to nearest available variant '${chosen.fullId}'.`,
			candidatesConsidered: asCandidateIds(variants),
		};
	}

	const scored = candidates
		.map((candidate) => ({ candidate, score: fuzzyScore(baseModel, candidate.id) }))
		.sort((a, b) => b.score - a.score);
	const best = scored[0];
	const second = scored[1];
	if (best && best.score >= 0.88 && best.score - (second?.score ?? 0) >= 0.06) {
		return {
			ok: true,
			kind: "fuzzy",
			requested,
			resolved: modelWithSuffix(best.candidate, thinkingSuffix),
			confidence: "high",
			note: `Resolved '${requested}' to high-confidence fuzzy match '${best.candidate.fullId}'.`,
			candidatesConsidered: scored.slice(0, 5).map((entry) => entry.candidate.fullId),
		};
	}

	return formatFailure(
		requested,
		best && best.score >= 0.80 ? "ambiguous" : "below-confidence-threshold",
		scored.slice(0, 5).map((entry) => entry.candidate.fullId),
		`Requested model '${requested}' could not be resolved with high confidence.`,
	);
}
