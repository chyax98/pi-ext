import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const sessionMap = new Map<string, string>();

export function setOvSessionId(piSessionId: string, ovSessionId: string) {
	sessionMap.set(piSessionId, ovSessionId);
}

export function clearOvSessionId(piSessionId: string) {
	sessionMap.delete(piSessionId);
}

export function getPiSessionIdFromContext(ctx: ExtensionContext | unknown): string | null {
	if (!ctx || typeof ctx !== "object") return null;
	const record = ctx as Record<string, unknown>;
	const sessionManager = record.sessionManager as
		| { getSessionId?: () => string | null | undefined }
		| undefined;
	try {
		return sessionManager?.getSessionId?.() ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("extension ctx is stale")) {
			return null;
		}
		throw error;
	}
}

export function getOvSessionIdForPiSession(piSessionId: string | null | undefined) {
	if (!piSessionId) return null;
	return sessionMap.get(piSessionId) ?? null;
}

export function getPiSessionIdForOvSessionId(ovSessionId: string | null | undefined) {
	if (!ovSessionId) return null;
	for (const [piSessionId, mappedOvSessionId] of sessionMap.entries()) {
		if (mappedOvSessionId === ovSessionId) return piSessionId;
	}
	return null;
}

export function getOvSessionIdFromContext(ctx: ExtensionContext | unknown): string | null {
	return getOvSessionIdForPiSession(getPiSessionIdFromContext(ctx));
}
