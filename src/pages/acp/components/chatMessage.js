export default function ChatMessage({ message }) {
	const $content = <div className="acp-message-content"></div>;
	const $meta = <div className="acp-message-meta"></div>;
	const $role = <div className="acp-message-role"></div>;

	function renderContent() {
		$content.innerHTML = "";
		message.content.forEach((block) => {
			if (block.type === "text") {
				$content.append(<span>{block.text}</span>);
			} else if (block.type === "resource_link") {
				$content.append(
					<a className="acp-resource-link" href="#">
						{block.name || block.uri}
					</a>,
				);
			} else if (block.type === "image" && block.data) {
				$content.append(
					<img
						src={`data:${block.mimeType};base64,${block.data}`}
						style="max-width:100%;border-radius:6px;margin:4px 0"
					/>,
				);
			}
		});
	}

	function renderMeta() {
		const timeStr = new Date(message.timestamp).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		$meta.textContent = message.streaming ? `${timeStr} · streaming` : timeStr;
		$role.textContent = message.role === "user" ? "You" : "Agent";
		$el.classList.toggle("streaming", Boolean(message.streaming));
	}

	renderContent();

	const $el = (
		<div className={`acp-message ${message.role}`}>
			{$role}
			{$content}
			{$meta}
		</div>
	);

	renderMeta();

	$el.update = (msg) => {
		message = msg.message || msg;
		renderContent();
		renderMeta();
	};

	return $el;
}
