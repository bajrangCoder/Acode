export default function AgentForm({ onConnect, statusMsg, isConnecting }) {
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
					{$cwdInput}
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
	};

	$el.setStatus = (msg) => {
		$status.textContent = msg || "";
	};

	return $el;
}
