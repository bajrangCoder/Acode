const STORAGE_KEY = "acpSessionHistory";
const MAX_ENTRIES = 30;
const VALID_STOP_REASONS = new Set([
	"end_turn",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"cancelled",
]);

export interface ACPHistoryTurnStop {
	stopReason: string;
	timestamp: number;
}

export interface ACPHistoryEntry {
	sessionId: string;
	url: string;
	cwd: string;
	agentName: string;
	title: string;
	preview: string;
	turnStops: ACPHistoryTurnStop[];
	createdAt: string;
	updatedAt: string;
}

type ACPHistoryFilter = {
	url?: string;
};

type ACPHistoryRemoveParams = {
	sessionId: string;
	url: string;
};

type ACPHistorySaveInput = Partial<ACPHistoryEntry> &
	Pick<ACPHistoryEntry, "sessionId" | "url">;

function normalizeEntry(entry: Partial<ACPHistoryEntry> = {}): ACPHistoryEntry {
	const createdAt = entry.createdAt || new Date().toISOString();
	const updatedAt = entry.updatedAt || createdAt;
	const turnStops = Array.isArray(entry.turnStops)
		? entry.turnStops
				.map((item) => {
					const stopReason =
						typeof item?.stopReason === "string" ? item.stopReason.trim() : "";
					if (!VALID_STOP_REASONS.has(stopReason)) return null;

					const timestamp = Number.isFinite(item?.timestamp)
						? Number(item.timestamp)
						: Date.now();

					return {
						stopReason,
						timestamp,
					};
				})
				.filter((item): item is ACPHistoryTurnStop => Boolean(item))
		: [];

	return {
		sessionId:
			typeof entry.sessionId === "string" ? entry.sessionId.trim() : "",
		url: typeof entry.url === "string" ? entry.url.trim() : "",
		cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : "",
		agentName:
			typeof entry.agentName === "string" ? entry.agentName.trim() : "",
		title: typeof entry.title === "string" ? entry.title.trim() : "",
		preview: typeof entry.preview === "string" ? entry.preview.trim() : "",
		turnStops,
		createdAt,
		updatedAt,
	};
}

function getTimestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function sortEntries(entries: ACPHistoryEntry[]): ACPHistoryEntry[] {
	return [...entries].sort((a, b) => {
		return getTimestamp(b.updatedAt) - getTimestamp(a.updatedAt);
	});
}

function parseEntries(): ACPHistoryEntry[] {
	let entries = null;
	try {
		entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
	} catch {
		entries = [];
	}
	if (!Array.isArray(entries)) return [];

	return entries
		.map((entry) => normalizeEntry(entry))
		.filter((entry) => entry.sessionId && entry.url);
}

function persist(entries: ACPHistoryEntry[]): void {
	const nextEntries = sortEntries(entries).slice(0, MAX_ENTRIES);
	localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEntries));
}

const acpHistory = {
	list(filter: ACPHistoryFilter = {}): ACPHistoryEntry[] {
		return sortEntries(parseEntries()).filter((entry) => {
			if (!filter.url) return true;
			return entry.url === filter.url;
		});
	},

	save(entry: ACPHistorySaveInput): ACPHistoryEntry | null {
		const normalized = normalizeEntry(entry);
		if (!normalized.sessionId || !normalized.url) return null;

		const entries = parseEntries();
		const index = entries.findIndex((item) => {
			return (
				item.sessionId === normalized.sessionId && item.url === normalized.url
			);
		});

		if (index >= 0) {
			const current = entries[index];
			entries[index] = {
				...current,
				...normalized,
				cwd: normalized.cwd || current.cwd,
				agentName: normalized.agentName || current.agentName,
				title: normalized.title || current.title,
				preview: normalized.preview || current.preview,
				turnStops:
					normalized.turnStops.length > 0
						? normalized.turnStops
						: current.turnStops,
				createdAt: current.createdAt,
				updatedAt: normalized.updatedAt || new Date().toISOString(),
			};
		} else {
			entries.unshift({
				...normalized,
				createdAt: normalized.createdAt || new Date().toISOString(),
				updatedAt: normalized.updatedAt || new Date().toISOString(),
			});
		}

		persist(entries);
		return normalized;
	},

	remove({ sessionId, url }: ACPHistoryRemoveParams): void {
		if (!sessionId || !url) return;

		persist(
			parseEntries().filter((entry) => {
				return !(entry.sessionId === sessionId && entry.url === url);
			}),
		);
	},
};

export default acpHistory;
