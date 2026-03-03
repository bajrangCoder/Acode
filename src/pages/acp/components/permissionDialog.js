export default function PermissionDialog({ request, onRespond }) {
	let resolved = false;
	let contentVisible = true;

	const toolCall = request.toolCall;
	const displayTitle = toolCall?.title
		? toolCall.title.length > 200
			? toolCall.title.slice(0, 200) + "…"
			: toolCall.title
		: "Unknown action";

	const $indicator = <span className="acp-permission-indicator"></span>;
	const $label = (
		<span className="acp-permission-label">Permission Required</span>
	);
	const $chevron = (
		<span className="acp-permission-chevron icon keyboard_arrow_down"></span>
	);

	const $denyBtn = (
		<button className="deny" onclick={() => handleAction("deny")}>
			Deny
		</button>
	);

	const $approveBtn = (
		<button className="approve" onclick={() => handleAction("approve")}>
			✓ Approve
		</button>
	);

	const $content = (
		<div className="acp-permission-content">
			<div className="acp-permission-tool-title">{displayTitle}</div>
			{toolCall?.kind
				? <div className="acp-permission-kind-badge">{toolCall.kind}</div>
				: null}
			<div className="acp-permission-actions">
				{$denyBtn}
				{$approveBtn}
			</div>
		</div>
	);

	const $header = (
		<div
			className="acp-permission-header"
			onclick={() => {
				contentVisible = !contentVisible;
				$content.classList.toggle("hidden", !contentVisible);
				$chevron.classList.toggle("collapsed", !contentVisible);
			}}
		>
			{$indicator}
			{$label}
			{$chevron}
		</div>
	);

	const $el = (
		<div className="acp-permission-card">
			{$header}
			{$content}
		</div>
	);

	function handleAction(action) {
		if (resolved) return;
		resolved = true;

		$denyBtn.disabled = true;
		$approveBtn.disabled = true;

		if (action === "approve") {
			$approveBtn.textContent = "✓ Approved";
			$approveBtn.className = "approved-state";
			$el.classList.add("resolved-approved");
			$label.textContent = "Permission Approved";

			onRespond({
				outcome: {
					outcome: "selected",
					optionId: findAllowOption(),
				},
			});
		} else {
			$denyBtn.textContent = "Denied";
			$denyBtn.className = "denied-state";
			$el.classList.add("resolved-denied");
			$label.textContent = "Permission Denied";

			onRespond({
				outcome: {
					outcome: "cancelled",
				},
			});
		}

		// Auto-collapse after response
		contentVisible = false;
		$content.classList.add("hidden");
		$chevron.classList.add("collapsed");
	}

	function findAllowOption() {
		const opts = request.options || [];
		const allow = opts.find(
			(o) => o.kind === "allow_once" || o.kind === "allow_always",
		);
		return allow ? allow.optionId : opts[0]?.optionId;
	}

	$el.update = () => {};

	return $el;
}
