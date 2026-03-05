const STOP_REASON_META = {
	end_turn: {
		label: "End turn",
		description: "Agent completed this turn.",
	},
	max_tokens: {
		label: "Max tokens",
		description: "Stopped after reaching the token limit.",
	},
	max_turn_requests: {
		label: "Max turn requests",
		description: "Stopped after reaching the turn request limit.",
	},
	refusal: {
		label: "Refusal",
		description: "Agent refused to continue for this prompt.",
	},
	cancelled: {
		label: "Cancelled",
		description: "Turn was cancelled before completion.",
	},
};

function normalizeStopReason(value) {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase();
}

function getStopReasonMeta(stopReason) {
	const normalized = normalizeStopReason(stopReason);
	if (STOP_REASON_META[normalized]) {
		return {
			key: normalized,
			...STOP_REASON_META[normalized],
		};
	}

	return {
		key: normalized || "unknown",
		label: "Stopped",
		description: "Agent ended this turn.",
	};
}

export default function StopReasonCard({ turnStop }) {
	let currentTurnStop = turnStop;

	const $label = <span className="acp-stop-reason-label"></span>;
	const $value = <span className="acp-stop-reason-value"></span>;
	const $description = <div className="acp-stop-reason-desc"></div>;

	function renderMeta() {
		const timestamp = new Date(currentTurnStop?.timestamp);
		$el.title = Number.isNaN(timestamp.getTime())
			? ""
			: timestamp.toLocaleString();
	}

	function render() {
		const meta = getStopReasonMeta(currentTurnStop?.stopReason);
		$label.textContent = meta.label;
		$value.textContent = meta.key ? `(${meta.key})` : "";
		$description.textContent = meta.description;
		$el.dataset.stopReason = meta.key;
		renderMeta();
	}

	const $el = (
		<div className="acp-stop-reason">
			<div className="acp-stop-reason-title">
				{$label}
				{$value}
			</div>
			{$description}
		</div>
	);

	render();

	$el.update = (entry) => {
		currentTurnStop = entry.turnStop || entry;
		render();
	};

	return $el;
}
