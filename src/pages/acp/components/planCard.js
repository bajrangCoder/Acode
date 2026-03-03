import { PlanEntryStatus } from "lib/acp/models";

export default function PlanCard({ plan }) {
	const $entries = <div className="acp-plan-entries"></div>;
	const $time = <div className="acp-plan-time"></div>;
	const $title = (
		<span className="acp-plan-title">
			{`Agent Plan${plan.title ? ": " + plan.title : ""}`}
		</span>
	);

	function render() {
		$entries.innerHTML = "";
		plan.entries.forEach((entry) => {
			const isDone = entry.status === PlanEntryStatus.COMPLETED;
			const statusText = isDone ? "✓" : "";

			$entries.append(
				<div className={`acp-plan-entry${isDone ? " step-done" : ""}`}>
					<span className={`acp-plan-status-icon ${entry.status}`}>
						{statusText}
					</span>
					<span className="acp-plan-content">{entry.content}</span>
					{entry.priority
						? <span className={`acp-plan-priority ${entry.priority}`}>
								{entry.priority}
							</span>
						: null}
				</div>,
			);
		});
	}

	render();

	function renderMeta() {
		if (!plan.timestamp) {
			$time.textContent = "";
			return;
		}
		$time.textContent = new Date(plan.timestamp).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	const $el = (
		<div className="acp-plan">
			<div className="acp-plan-header">
				<span className="acp-plan-icon">☰</span>
				{$title}
				{$time}
			</div>
			{$entries}
		</div>
	);

	renderMeta();

	$el.update = (entry) => {
		plan = entry.plan || entry;
		$title.textContent = `Agent Plan${plan.title ? ": " + plan.title : ""}`;
		render();
		renderMeta();
	};

	return $el;
}
