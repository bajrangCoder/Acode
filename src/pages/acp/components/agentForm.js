export default function AgentForm({
	onConnect,
	onPickCwd,
	statusMsg,
	isConnecting,
}) {
	const $urlInput = (
		<input
			type="text"
			placeholder="ws://localhost:7860"
			value="ws://localhost:7860"
		/>
	);

	const $cwdInput = (
		<input type="text" placeholder="e.g. /home/user/project (optional)" />
	);

	const $cwdPickBtn = (
		<button
			type="button"
			className="acp-cwd-pick-btn"
			title="Select working directory"
			disabled={isConnecting}
			onclick={async () => {
				if (typeof onPickCwd !== "function") return;
				const selectedCwd = await onPickCwd($cwdInput.value.trim());
				if (typeof selectedCwd === "string" && selectedCwd.trim()) {
					$cwdInput.value = selectedCwd.trim();
				}
			}}
		>
			<i className="icon folder_open"></i>
		</button>
	);

	const $btn = (
		<button
			className={`acp-connect-btn${isConnecting ? " connecting" : ""}`}
			disabled={isConnecting}
			onclick={() => {
				const url = $urlInput.value.trim();
				const cwd = $cwdInput.value.trim();
				if (!url) return;
				onConnect({ url, cwd });
			}}
		>
			Connect
		</button>
	);

	const $status = <div className="acp-status-msg">{statusMsg || ""}</div>;

	const $el = (
		<div className="acp-connect-view">
			<div className="acp-connect-header">
				<div className="acp-logo">⚡</div>
				<h2>ACP Agent</h2>
				<div className="acp-subtitle">
					Connect to an Agent Client Protocol agent
				</div>
			</div>
			<div className="acp-form">
				<div className="acp-field">
					<label>Agent WebSocket URL</label>
					{$urlInput}
				</div>
				<div className="acp-field">
					<label>Working Directory</label>
					<div className="acp-cwd-input-row">
						{$cwdInput}
						{$cwdPickBtn}
					</div>
				</div>
				{$btn}
			</div>
			{$status}
		</div>
	);

	$el.setConnecting = (connecting) => {
		$btn.disabled = connecting;
		$btn.className = `acp-connect-btn${connecting ? " connecting" : ""}`;
		$btn.textContent = connecting ? "" : "Connect";
		$cwdPickBtn.disabled = connecting;
	};

	$el.setStatus = (msg) => {
		$status.textContent = msg || "";
	};

	$el.getValues = () => ({
		url: $urlInput.value.trim(),
		cwd: $cwdInput.value.trim(),
	});

	$el.setValues = ({ url = "", cwd = "" } = {}) => {
		if (typeof url === "string" && url) $urlInput.value = url;
		if (typeof cwd === "string") $cwdInput.value = cwd;
	};

	return $el;
}
