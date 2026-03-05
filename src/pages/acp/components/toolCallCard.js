import { ToolCallStatus } from "lib/acp/models";

function truncateTitle(title, maxLen = 40) {
	if (!title) return "Tool call";
	if (title.length <= maxLen) return title;
	const firstLine = title.split("\n")[0];
	if (firstLine.length <= maxLen) return firstLine;
	return firstLine.slice(0, maxLen) + "…";
}

function renderUnknownValue(value) {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export default function ToolCallCard({ toolCall }) {
	const currentStatus = toolCall.status || ToolCallStatus.PENDING;
	const isOpen = {
		value: false,
	};
	let hasUserToggled = false;

	function computeAutoOpen(nextToolCall = toolCall) {
		return (
			nextToolCall.status === ToolCallStatus.IN_PROGRESS ||
			Boolean(nextToolCall.content?.length)
		);
	}

	function spinnerClass(status) {
		if (status === ToolCallStatus.IN_PROGRESS)
			return "acp-tool-spinner spinning";
		if (status === ToolCallStatus.COMPLETED)
			return "acp-tool-spinner completed";
		if (status === ToolCallStatus.FAILED) return "acp-tool-spinner failed";
		return "acp-tool-spinner";
	}

	function spinnerContent(status) {
		if (status === ToolCallStatus.COMPLETED) return "✓";
		if (status === ToolCallStatus.FAILED) return "✕";
		return "";
	}

	const $spinner = (
		<span className={spinnerClass(currentStatus)}>
			{spinnerContent(currentStatus)}
		</span>
	);
	const $chevron = (
		<span
			className={`acp-tool-chevron${isOpen.value ? " open" : ""} icon keyboard_arrow_down`}
		></span>
	);
	const $body = <div className="acp-tool-body"></div>;

	function applyOpenState() {
		$body.classList.toggle("open", isOpen.value);
		$chevron.classList.toggle("open", isOpen.value);
	}

	function renderBody() {
		$body.innerHTML = "";
		if (toolCall.content?.length) {
			toolCall.content.forEach((tc) => {
				if (tc.type === "content" && tc.content) {
					const text =
						tc.content.type === "text"
							? tc.content.text
							: JSON.stringify(tc.content);
					$body.append(<div className="acp-tool-content">{text}</div>);
				}
				if (tc.type === "diff") {
					$body.append(
						<div className="acp-tool-content">
							{`File: ${tc.path}\n${tc.newText || ""}`}
						</div>,
					);
				}
				if (tc.type === "terminal" && tc.terminalId) {
					$body.append(
						<div className="acp-tool-content">
							{`Terminal: ${tc.terminalId}`}
						</div>,
					);
				}
			});
		}

		if (toolCall.locations?.length) {
			const $locations = <div className="acp-tool-locations"></div>;
			toolCall.locations.forEach((loc) => {
				if (!loc || !loc.path) return;
				const label = loc.path.split("/").pop() || loc.path;
				$locations.append(<span className="acp-tool-location">{label}</span>);
			});
			if ($locations.childElementCount > 0) {
				$body.append($locations);
			}
		}

		if (toolCall.rawInput != null) {
			$body.append(
				<div className="acp-tool-section">
					<div className="acp-tool-section-title">Input</div>
					<div className="acp-tool-content">
						{renderUnknownValue(toolCall.rawInput)}
					</div>
				</div>,
			);
		}

		if (toolCall.rawOutput != null) {
			$body.append(
				<div className="acp-tool-section">
					<div className="acp-tool-section-title">Output</div>
					<div className="acp-tool-content">
						{renderUnknownValue(toolCall.rawOutput)}
					</div>
				</div>,
			);
		}
	}

	function renderCardMeta() {
		const timestamp = new Date(toolCall.timestamp);
		$el.title = Number.isNaN(timestamp.getTime())
			? ""
			: timestamp.toLocaleString();
	}

	const $header = (
		<div
			className="acp-tool-header"
			onclick={() => {
				hasUserToggled = true;
				isOpen.value = !isOpen.value;
				applyOpenState();
				if (isOpen.value) renderBody();
			}}
		>
			{$spinner}
			<div className="acp-tool-info">
				<span className="acp-tool-title">{truncateTitle(toolCall.title)}</span>
				<div className="acp-tool-kind">
					{`Using tool: ${toolCall.kind || "tool"}`}
				</div>
			</div>
			{$chevron}
		</div>
	);

	const $el = (
		<div className="acp-tool-call">
			{$header}
			{$body}
		</div>
	);

	isOpen.value = computeAutoOpen(toolCall);
	applyOpenState();
	renderCardMeta();
	if (isOpen.value) renderBody();

	$el.update = (entry) => {
		toolCall = entry.toolCall || entry;
		const status = toolCall.status || "pending";

		// Update spinner
		$spinner.className = spinnerClass(status);
		$spinner.textContent = spinnerContent(status);

		// Update info
		const $titleEl = $header.querySelector(".acp-tool-title");
		if ($titleEl) $titleEl.textContent = truncateTitle(toolCall.title);
		const $kindEl = $header.querySelector(".acp-tool-kind");
		if ($kindEl) $kindEl.textContent = `Using tool: ${toolCall.kind || "tool"}`;

		if (!hasUserToggled) {
			isOpen.value = computeAutoOpen(toolCall);
			applyOpenState();
		}
		renderCardMeta();
		if (isOpen.value) renderBody();
	};

	return $el;
}
