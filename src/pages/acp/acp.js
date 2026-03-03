import "./acp.scss";
import Page from "components/page";
import toast from "components/toast";
import select from "dialogs/select";
import { ACPClient } from "lib/acp/client";
import acpHistory from "lib/acp/history";
import { ConnectionState } from "lib/acp/models";
import actionStack from "lib/actionStack";
import helpers from "utils/helpers";
import AgentForm from "./components/agentForm";
import ChatMessage from "./components/chatMessage";
import PermissionDialog from "./components/permissionDialog";
import PlanCard from "./components/planCard";
import ToolCallCard from "./components/toolCallCard";

export default function AcpPageInclude() {
	const $page = Page("ACP Agent");
	$page.classList.add("acp-page");

	const client = new ACPClient();
	let currentView = "connect";
	let connectedUrl = "";
	let currentSessionUrl = "";
	const timelineElements = new Map();
	let isPrompting = false;

	// ─── Connection Form ───
	const $form = AgentForm({
		onConnect: handleConnect,
		statusMsg: "",
		isConnecting: false,
	});

	// ─── Chat View ───
	const $chatView = buildChatView();
	const $historyBtn = (
		<span
			className="icon historyrestore"
			title="Session history"
			attr-action="open-history"
		></span>
	);
	$page.header.append($historyBtn);
	$page.addEventListener("click", handlePageClick);

	// Start with connection form
	$page.body = <main className="main scroll">{$form}</main>;

	async function handleConnect({ url, cwd }) {
		if (!url) return;

		const nextCwd = cwd || "";
		$form.setValues({ url, cwd: nextCwd });
		$form.setConnecting(true);
		setFormStatus("");

		try {
			setFormStatus("Connecting...");
			await ensureReadyForUrl(url);
			setFormStatus("Starting session...");
			await client.newSession(nextCwd || undefined);
			currentSessionUrl = url;
			switchToChat(client.agentName);
			saveCurrentSessionHistory();
			syncTimeline();
		} catch (err) {
			$form.setConnecting(false);
			setFormStatus(err.message || "Connection failed");
		}
	}

	async function ensureReadyForUrl(url) {
		if (client.state === ConnectionState.READY && connectedUrl === url) return;

		if (client.state !== ConnectionState.DISCONNECTED) {
			try {
				await client.disconnect();
			} catch {
				/* ignore */
			}
		}

		await client.connect({ type: "websocket", url });
		await client.initialize();
		connectedUrl = url;
	}

	function switchToChat(agentName) {
		currentView = "chat";
		timelineElements.clear();

		setChatAgentName(agentName);

		setPrompting(false);
		updateStatusDot("connected");

		$page.body = <main className="main scroll">{$chatView}</main>;

		const $messages = $chatView.querySelector(".acp-messages");
		if ($messages) $messages.innerHTML = "";
		ensureEmptyState();

		// Back from chat → disconnect and return to connect form
		if (actionStack.has("acp-chat")) {
			actionStack.remove("acp-chat");
		}
		actionStack.push({
			id: "acp-chat",
			action: handleDisconnect,
		});
	}

	function switchToConnect() {
		currentView = "connect";
		timelineElements.clear();
		$form.setConnecting(false);
		setFormStatus("");
		setPrompting(false);

		actionStack.remove("acp-chat");

		$page.body = <main className="main scroll">{$form}</main>;
	}

	function handlePageClick(e) {
		const action = e.target?.getAttribute?.("action");
		if (action === "open-history") {
			void openSessionHistory();
		}
	}

	function setChatAgentName(agentName) {
		const $agentNameEl = $chatView.querySelector(".acp-agent-name");
		if ($agentNameEl) $agentNameEl.textContent = agentName || "Agent";
	}

	function buildChatView() {
		const $messages = <div className="acp-messages scroll"></div>;

		const $emptyState = (
			<div className="acp-empty-state">
				<div className="acp-empty-icon">⚡</div>
				<div className="acp-empty-title">Start a conversation</div>
				<div className="acp-empty-desc">
					Ask the agent to write code, fix bugs, refactor, or explore your
					project.
				</div>
				<div className="acp-suggestions">
					<span
						className="acp-suggestion"
						onclick={() => sendSuggestion("Explain this project")}
					>
						Explain this project
					</span>
					<span
						className="acp-suggestion"
						onclick={() => sendSuggestion("Find and fix bugs")}
					>
						Find & fix bugs
					</span>
					<span
						className="acp-suggestion"
						onclick={() => sendSuggestion("Refactor this file")}
					>
						Refactor this file
					</span>
				</div>
			</div>
		);

		function sendSuggestion(text) {
			$textarea.value = text;
			handleSend();
		}

		const $textarea = (
			<textarea
				placeholder="Message agent…"
				rows="1"
				enterkeyhint="newline"
				oninput={(e) => {
					e.target.style.height = "auto";
					e.target.style.height = Math.min(e.target.scrollHeight, 128) + "px";
				}}
			></textarea>
		);

		const $attachBtn = (
			<button className="acp-attach-btn" title="Attach context">
				<i className="icon attach_file"></i>
			</button>
		);

		const $sendBtn = (
			<button className="acp-send-btn" onclick={handleSend}>
				<i className="icon send"></i>
			</button>
		);

		const $cancelBtn = (
			<button
				className="acp-cancel-btn"
				onclick={() => client.cancel()}
				style="display:none"
			>
				<i className="icon not_interesteddo_not_disturb"></i>
			</button>
		);

		async function handleSend() {
			const text = $textarea.value.trim();
			if (!text || isPrompting) return;

			// Remove empty state when first message is sent
			if ($emptyState.parentNode) $emptyState.remove();

			$textarea.value = "";
			$textarea.style.height = "auto";

			setPrompting(true, { $sendBtn, $cancelBtn });

			try {
				const promptRequest = client.sendTextPrompt(text);
				syncTimeline();
				await promptRequest;
			} catch (err) {
				console.error("[ACP] Prompt error:", err);
			} finally {
				saveCurrentSessionHistory();
				setPrompting(false, { $sendBtn, $cancelBtn });
			}
		}

		const $view = (
			<div className="acp-chat-view">
				<div className="acp-chat-header">
					<div className="acp-header-left">
						<div className="acp-agent-avatar">
							<span className="acp-avatar-icon">⚡</span>
							<span className="acp-status-indicator">
								<span className="acp-status-ping"></span>
								<span className="acp-status-dot"></span>
							</span>
						</div>
						<div className="acp-header-info">
							<span className="acp-agent-name">Agent</span>
							<span className="acp-status-label">Connected</span>
						</div>
					</div>
					<button
						className="acp-disconnect-btn"
						onclick={handleDisconnect}
						title="Disconnect"
					>
						<i className="icon cancel"></i>
					</button>
				</div>
				{$emptyState}
				{$messages}
				<div className="acp-input-area">
					<div className="acp-input-wrapper">
						{$attachBtn}
						{$textarea}
						{$sendBtn}
						{$cancelBtn}
					</div>
				</div>
			</div>
		);

		$view.ensureEmptyState = () => {
			if ($messages.children.length > 0) return;
			if ($emptyState.parentNode !== $view) {
				$view.insertBefore($emptyState, $messages);
			}
		};

		return $view;
	}

	function ensureEmptyState() {
		if (typeof $chatView.ensureEmptyState === "function") {
			$chatView.ensureEmptyState();
		}
	}

	async function handleDisconnect() {
		try {
			await client.disconnect();
		} catch {
			/* ignore */
		}
		connectedUrl = "";
		currentSessionUrl = "";
		switchToConnect();
	}

	function getSessionPreview() {
		const session = client.session;
		if (!session) return "";

		const userMessage = session.messages.find((message) => {
			return message.role === "user";
		});
		const textBlock = userMessage?.content.find((block) => {
			return block.type === "text";
		});

		if (!textBlock || textBlock.type !== "text") return "";
		return textBlock.text.trim().slice(0, 120);
	}

	function getSessionLabel(entry) {
		const title =
			entry.title || entry.preview || `Session ${entry.sessionId.slice(0, 8)}`;
		const meta = [
			entry.agentName || "Agent",
			entry.cwd || entry.url,
			formatUpdatedAt(entry.updatedAt),
		]
			.filter(Boolean)
			.join(" • ");
		return `${title}<br><small>${meta}</small>`;
	}

	function formatUpdatedAt(value) {
		if (!value) return "";
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleString();
	}

	function getUpdatedAtTime(value) {
		const parsed = Date.parse(value || "");
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	function saveCurrentSessionHistory() {
		const session = client.session;
		if (!session || !currentSessionUrl) return;

		acpHistory.save({
			sessionId: session.sessionId,
			url: currentSessionUrl,
			cwd: session.cwd || $form.getValues().cwd || "",
			agentName: client.agentName,
			title: session.title || "",
			preview: getSessionPreview(),
			updatedAt: session.updatedAt || new Date().toISOString(),
		});
	}

	function getSessionHistoryEntries() {
		return acpHistory.list().sort((a, b) => {
			return getUpdatedAtTime(b.updatedAt) - getUpdatedAtTime(a.updatedAt);
		});
	}

	async function openSessionHistory() {
		const entries = getSessionHistoryEntries();
		if (!entries.length) {
			toast("No saved ACP sessions yet");
			if (currentView === "connect") {
				setFormStatus("No saved ACP sessions yet");
			}
			return;
		}

		try {
			const selectedEntry = await select(
				"ACP Session History",
				entries.map((entry) => ({
					value: entry,
					text: getSessionLabel(entry),
					icon:
						currentSessionUrl &&
						currentSessionUrl === entry.url &&
						client.session?.sessionId === entry.sessionId
							? "radio_button_checked"
							: "historyrestore",
					tailElement: tag("span", {
						className: "icon clearclose",
						dataset: {
							action: "clear",
						},
					}),
					ontailclick: () => {
						acpHistory.remove({
							sessionId: entry.sessionId,
							url: entry.url,
						});
					},
				})),
				{
					textTransform: false,
				},
			);

			if (!selectedEntry) return;
			await loadSelectedSession(selectedEntry);
		} catch (error) {
			if (!error) return;
			console.error("[ACP] Failed to open session history:", error);
			toast(error.message || "Failed to open session history");
		}
	}

	async function loadSelectedSession(entry) {
		const cwd = entry.cwd || $form.getValues().cwd || "";
		if (!cwd) {
			setFormStatus("This session is missing a working directory");
			return;
		}

		$form.setValues({
			url: entry.url,
			cwd,
		});
		$form.setConnecting(true);
		setFormStatus("");

		try {
			setFormStatus("Connecting...");
			await ensureReadyForUrl(entry.url);
			switchToChat(entry.agentName || client.agentName);
			updateStatusDot("connecting");

			await client.loadSession(entry.sessionId, cwd);
			currentSessionUrl = entry.url;
			setChatAgentName(entry.agentName || client.agentName);
			saveCurrentSessionHistory();
			syncTimeline();
			updateStatusDot("connected");
		} catch (error) {
			console.error("[ACP] Failed to load session:", error);
			try {
				await client.disconnect();
			} catch {
				/* ignore */
			}
			connectedUrl = "";
			currentSessionUrl = "";
			switchToConnect();
			setFormStatus(error.message || "Failed to load session");
		} finally {
			$form.setConnecting(false);
			setPrompting(false);
		}
	}

	function updateStatusDot(state) {
		const $dot = $chatView.querySelector(".acp-status-dot");
		const $ping = $chatView.querySelector(".acp-status-ping");
		const $label = $chatView.querySelector(".acp-status-label");
		if (!$dot) return;

		$dot.className = "acp-status-dot";
		if ($ping) $ping.className = "acp-status-ping";

		if (state === "connected") {
			$dot.classList.add("connected");
			if ($ping) $ping.classList.add("connected");
			if ($label) $label.textContent = "Connected";
		} else if (state === "connecting") {
			$dot.classList.add("working");
			if ($ping) {
				$ping.classList.add("active", "working");
			}
			if ($label) $label.textContent = "Working…";
		} else if (state === "error") {
			$dot.classList.add("error");
			if ($label) $label.textContent = "Error";
		}
	}

	function setFormStatus(message) {
		$form.setStatus(message);
	}

	function setPrompting(
		value,
		elements = {
			$sendBtn: $chatView.querySelector(".acp-send-btn"),
			$cancelBtn: $chatView.querySelector(".acp-cancel-btn"),
		},
	) {
		isPrompting = value;
		if (elements.$sendBtn) {
			elements.$sendBtn.style.display = value ? "none" : "flex";
		}
		if (elements.$cancelBtn) {
			elements.$cancelBtn.style.display = value ? "flex" : "none";
		}
		updateStatusDot(value ? "connecting" : "connected");
	}

	// ─── Event Handlers ───
	function createTimelineElement(entry) {
		switch (entry.type) {
			case "message":
				return ChatMessage({ message: entry.message });
			case "tool_call":
				return ToolCallCard({ toolCall: entry.toolCall });
			case "plan":
				return PlanCard({ plan: entry.plan });
			default:
				return null;
		}
	}

	function syncTimeline() {
		if (!client.session) return;
		const entries = client.session.timeline;
		const $messages = $chatView.querySelector(".acp-messages");
		if (!$messages) return;

		// Remove empty state when timeline has entries
		if (entries.length > 0) {
			const $empty = $chatView.querySelector(".acp-empty-state");
			if ($empty) $empty.remove();
		}

		entries.forEach((entry) => {
			if (timelineElements.has(entry.entryId)) {
				timelineElements.get(entry.entryId).update(entry);
			} else {
				const $entry = createTimelineElement(entry);
				if (!$entry) return;
				timelineElements.set(entry.entryId, $entry);
				$messages.append($entry);
			}
		});

		$messages.scrollTop = $messages.scrollHeight;
		saveCurrentSessionHistory();
	}

	client.on("session_update", () => {
		syncTimeline();
	});

	client.on("permission_request", (data) => {
		const $dialog = PermissionDialog({
			request: data,
			onRespond: (response) => {
				client.respondPermission(data.requestId, response);
			},
		});
		const $messages = $chatView.querySelector(".acp-messages");
		if ($messages) {
			$messages.append($dialog);
			$messages.scrollTop = $messages.scrollHeight;
		}
	});

	client.on("state_change", ({ newState }) => {
		if (newState === ConnectionState.DISCONNECTED) {
			connectedUrl = "";
			currentSessionUrl = "";
		}
		if (currentView !== "chat") return;
		if (newState === ConnectionState.DISCONNECTED) {
			switchToConnect();
		} else if (newState === ConnectionState.ERROR) {
			updateStatusDot("error");
		}
	});

	client.on("error", (error) => {
		console.error("[ACP] Client error:", error);
		if (currentView === "chat") {
			updateStatusDot("error");
		} else {
			setFormStatus(error.message || "ACP error");
		}
	});

	// ─── Page Lifecycle ───
	actionStack.push({
		id: "acp",
		action: $page.hide,
	});

	$page.onhide = function () {
		actionStack.remove("acp-chat");
		actionStack.remove("acp");
		client.dispose();
		helpers.hideAd();
	};

	app.append($page);
	helpers.showAd();
}
