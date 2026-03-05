import "./acp.scss";
import fsOperation from "fileSystem";
import Page from "components/page";
import toast from "components/toast";
import select from "dialogs/select";
import { filesize } from "filesize";
import { ACPClient } from "lib/acp/client";
import acpHistory from "lib/acp/history";
import { ConnectionState } from "lib/acp/models";
import actionStack from "lib/actionStack";
import { addedFolder } from "lib/openFolder";
import mimeType from "mime-types";
import FileBrowser from "pages/fileBrowser";
import helpers from "utils/helpers";
import Url from "utils/Url";
import AgentForm from "./components/agentForm";
import ChatMessage from "./components/chatMessage";
import PermissionDialog from "./components/permissionDialog";
import PlanCard from "./components/planCard";
import StopReasonCard from "./components/stopReasonCard";
import ToolCallCard from "./components/toolCallCard";

export default function AcpPageInclude() {
	const $page = Page("ACP Agent");
	$page.classList.add("acp-page");

	const client = new ACPClient();
	let currentView = "connect";
	let connectedUrl = "";
	let currentSessionUrl = "";
	const timelineElements = new Map();
	let pendingTurnIndicatorElement = null;
	let isPrompting = false;
	let activePromptSessionId = null;
	const BROWSE_CWD_OPTION = "__acp_cwd_browse__";

	// ─── Connection Form ───
	const $form = AgentForm({
		onConnect: handleConnect,
		onPickCwd: handlePickWorkingDirectory,
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

		const nextCwd = normalizeSessionCwd(cwd || "");
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

	function getTerminalPaths() {
		const packageName = window.BuildInfo?.packageName || "com.foxdebug.acode";
		const dataDir = `/data/user/0/${packageName}`;
		return {
			alpineRoot: `${dataDir}/files/alpine`,
			publicDir: `${dataDir}/files/public`,
		};
	}

	function normalizePathInput(value = "") {
		return String(value || "")
			.trim()
			.replace(/^<|>$/g, "")
			.replace(/^["']|["']$/g, "");
	}

	function isTerminalPublicSafUri(value = "") {
		return value.startsWith("content://com.foxdebug.acode.documents/tree/");
	}

	function convertToTerminalCwd(value = "", allowRawFallback = false) {
		const normalized = normalizePathInput(value);
		if (!normalized) return "";

		if (normalized === "~") return "/home";
		if (normalized.startsWith("~/")) return `/home/${normalized.slice(2)}`;
		if (normalized === "/home" || normalized.startsWith("/home/")) {
			return normalized;
		}
		if (normalized === "/public" || normalized.startsWith("/public/")) {
			return normalized;
		}
		if (isTerminalPublicSafUri(normalized)) {
			return "/public";
		}

		const protocol = Url.getProtocol(normalized);
		if (protocol && protocol !== "file:") {
			return allowRawFallback ? normalized : "";
		}

		const { alpineRoot, publicDir } = getTerminalPaths();
		const cleanValue = normalized.replace(/^file:\/\//, "");
		if (cleanValue.startsWith(publicDir)) {
			const suffix = cleanValue.slice(publicDir.length);
			return suffix ? `/public${suffix}` : "/public";
		}
		if (cleanValue.startsWith(alpineRoot)) {
			const suffix = cleanValue.slice(alpineRoot.length);
			return suffix ? (suffix.startsWith("/") ? suffix : `/${suffix}`) : "/";
		}
		if (
			cleanValue.startsWith("/sdcard") ||
			cleanValue.startsWith("/storage") ||
			cleanValue.startsWith("/data")
		) {
			return cleanValue;
		}

		return allowRawFallback ? normalized : "";
	}

	function normalizeSessionCwd(value = "") {
		return convertToTerminalCwd(value, true);
	}

	function toFolderLabel(folder = {}) {
		const title = normalizePathInput(folder.title || "");
		if (title) return title;
		const url = normalizePathInput(folder.url || "");
		return Url.basename(url) || url || "Folder";
	}

	function getDirectorySelectionItems(currentCwd = "") {
		const items = [
			{
				value: BROWSE_CWD_OPTION,
				text: "Browse folder…",
				icon: "folder_open",
			},
		];
		const seenValues = new Set([BROWSE_CWD_OPTION]);
		const normalizedCurrent = normalizeSessionCwd(currentCwd);

		const pushItem = (value, text, icon = "folder") => {
			if (!value || seenValues.has(value)) return;
			seenValues.add(value);
			items.push({
				value,
				text,
				icon,
			});
		};

		if (normalizedCurrent) {
			const currentIsTerminalAccessible = Boolean(
				convertToTerminalCwd(normalizedCurrent, false),
			);
			pushItem(
				normalizedCurrent,
				currentIsTerminalAccessible
					? `Current value<br><small>${normalizedCurrent}</small>`
					: `Current value<br><small>${normalizedCurrent} • terminal unavailable</small>`,
				currentIsTerminalAccessible ? "radio_button_checked" : "warning",
			);
		}

		addedFolder.forEach((folder) => {
			const rawUrl = normalizePathInput(folder?.url || "");
			if (!rawUrl) return;

			const converted = convertToTerminalCwd(rawUrl, false);
			const cwdValue = converted || normalizeSessionCwd(rawUrl);
			if (!cwdValue) return;
			const label = toFolderLabel(folder);
			pushItem(
				cwdValue,
				converted
					? `${label}<br><small>${cwdValue}</small>`
					: `${label}<br><small>${cwdValue} • terminal unavailable</small>`,
				converted ? "folder" : "warning",
			);
		});

		return items;
	}

	async function handlePickWorkingDirectory(currentCwd = "") {
		try {
			const selected = await select(
				"Select Working Directory",
				getDirectorySelectionItems(currentCwd),
				{
					textTransform: false,
				},
			);
			if (!selected) return null;

			if (selected === BROWSE_CWD_OPTION) {
				const folder = await FileBrowser("folder", "Select working directory");
				const nextCwd = normalizeSessionCwd(folder?.url || "");
				if (!nextCwd) {
					toast("Failed to resolve selected folder");
					return null;
				}
				if (!convertToTerminalCwd(folder?.url || "", false)) {
					toast(
						"Selected folder supports ACP file access, but terminal tools may be unavailable",
					);
				}
				return nextCwd;
			}

			return normalizeSessionCwd(selected);
		} catch (error) {
			if (!error) return null;
			console.error("[ACP] Failed to pick working directory:", error);
			toast(error?.message || "Failed to choose working directory");
			return null;
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
		pendingTurnIndicatorElement = null;

		setChatAgentName(agentName);

		setPrompting(false);
		updateStatusDot("connected");

		$page.body = <main className="main scroll">{$chatView}</main>;

		const $messages = $chatView.querySelector(".acp-messages");
		if ($messages) $messages.innerHTML = "";
		ensureEmptyState();
		$chatView.resetComposer?.();
		$chatView.refreshComposerControls?.();

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
		pendingTurnIndicatorElement = null;
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
		let pendingAttachments = [];
		let isSelectingAttachment = false;
		let isUpdatingSessionControl = false;

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
			updateSendButtonState();
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
					updateSendButtonState();
				}}
			></textarea>
		);

		const $attachBtn = (
			<button
				className="acp-attach-btn"
				title="Attach context file"
				onclick={handleAttachContext}
			>
				<i className="icon attach_file"></i>
			</button>
		);

		const $sendBtn = (
			<button className="acp-send-btn" onclick={handleSend} disabled>
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

		const $sessionControls = (
			<div className="acp-session-controls hidden"></div>
		);

		const $attachmentPreview = (
			<div className="acp-attachment-preview hidden"></div>
		);
		const MAX_INLINE_MEDIA_BYTES = 5 * 1024 * 1024;

		const SESSION_CONTROL_PRIORITY = {
			mode: 0,
			model: 1,
			thought_level: 2,
		};

		function normalizeText(value, fallback = "") {
			return typeof value === "string" && value.trim()
				? value.trim()
				: fallback;
		}

		function isGroupedSessionOptionList(options) {
			if (!Array.isArray(options) || options.length === 0) return false;
			const first = options[0];
			return Boolean(first && Array.isArray(first.options));
		}

		function flattenSessionOptionChoices(option) {
			const optionList = Array.isArray(option?.options) ? option.options : [];
			if (!optionList.length) return [];

			if (isGroupedSessionOptionList(optionList)) {
				return optionList.flatMap((group) => {
					const groupName = normalizeText(group?.name, "");
					const groupOptions = Array.isArray(group?.options)
						? group.options
						: [];
					return groupOptions
						.map((entry) => {
							const value = normalizeText(entry?.value, "");
							const name = normalizeText(entry?.name, value);
							if (!value || !name) return null;
							return {
								value,
								name,
								description: normalizeText(entry?.description, ""),
								groupName,
							};
						})
						.filter(Boolean);
				});
			}

			return optionList
				.map((entry) => {
					const value = normalizeText(entry?.value, "");
					const name = normalizeText(entry?.name, value);
					if (!value || !name) return null;
					return {
						value,
						name,
						description: normalizeText(entry?.description, ""),
						groupName: "",
					};
				})
				.filter(Boolean);
		}

		function findChoiceName(choices, selectedValue, fallback) {
			const nextValue = normalizeText(selectedValue, "");
			const choice = choices.find((item) => item.value === nextValue);
			if (choice?.name) return choice.name;
			return normalizeText(nextValue, fallback);
		}

		function formatSelectLabel(choice) {
			return choice.groupName
				? `${choice.groupName} · ${choice.name}`
				: choice.name;
		}

		function toSessionControls() {
			const controls = [];
			const hasModeState = Boolean(client.sessionModes?.availableModes?.length);
			const hasModelState = Boolean(
				client.sessionModels?.availableModels?.length,
			);

			const modeState = client.sessionModes;
			if (hasModeState && modeState) {
				const choices = modeState.availableModes
					.map((mode) => {
						const value = normalizeText(mode?.id, "");
						const name = normalizeText(mode?.name, value);
						if (!value || !name) return null;
						return {
							value,
							name,
							description: normalizeText(mode?.description, ""),
							groupName: "",
						};
					})
					.filter(Boolean);

				if (choices.length) {
					controls.push({
						kind: "mode",
						name: "Mode",
						category: "mode",
						currentValue: normalizeText(modeState.currentModeId, ""),
						currentName: findChoiceName(
							choices,
							modeState.currentModeId,
							"Mode",
						),
						displayText: findChoiceName(
							choices,
							modeState.currentModeId,
							"Mode",
						),
						choices,
					});
				}
			}

			const modelState = client.sessionModels;
			if (hasModelState && modelState) {
				const choices = modelState.availableModels
					.map((model) => {
						const value = normalizeText(model?.modelId, "");
						const name = normalizeText(model?.name, value);
						if (!value || !name) return null;
						return {
							value,
							name,
							description: normalizeText(model?.description, ""),
							groupName: "",
						};
					})
					.filter(Boolean);

				if (choices.length) {
					controls.push({
						kind: "model",
						name: "Model",
						category: "model",
						currentValue: normalizeText(modelState.currentModelId, ""),
						currentName: findChoiceName(
							choices,
							modelState.currentModelId,
							"Model",
						),
						displayText: findChoiceName(
							choices,
							modelState.currentModelId,
							"Model",
						),
						choices,
					});
				}
			}

			const configControls = (client.sessionConfigOptions || [])
				.map((option) => {
					if (!option || option.type !== "select") return null;
					const optionId = normalizeText(option.id, "");
					if (!optionId) return null;

					const category = normalizeText(option.category, "");
					if (category === "mode" && hasModeState) return null;
					if (category === "model" && hasModelState) return null;

					const choices = flattenSessionOptionChoices(option);
					if (!choices.length) return null;

					const currentValue = normalizeText(option.currentValue, "");
					const currentName = findChoiceName(choices, currentValue, "Select");
					const name = normalizeText(option.name, optionId);
					const isPrimary =
						category === "mode" ||
						category === "model" ||
						category === "thought_level";

					return {
						kind: "config",
						id: optionId,
						name,
						category,
						currentValue,
						currentName,
						description: normalizeText(option.description, ""),
						displayText: isPrimary ? currentName : `${name}: ${currentName}`,
						choices,
					};
				})
				.filter(Boolean)
				.sort((a, b) => {
					const priorityA =
						SESSION_CONTROL_PRIORITY[a.category] ?? Number.MAX_SAFE_INTEGER;
					const priorityB =
						SESSION_CONTROL_PRIORITY[b.category] ?? Number.MAX_SAFE_INTEGER;
					if (priorityA !== priorityB) return priorityA - priorityB;
					return a.name.localeCompare(b.name);
				});

			return [...controls, ...configControls];
		}

		async function applySessionControl(control, nextValue) {
			if (!client.session || !nextValue) return;
			if (nextValue === control.currentValue) return;

			isUpdatingSessionControl = true;
			renderSessionControls();

			try {
				if (control.kind === "mode") {
					await client.setSessionMode(nextValue);
				} else if (control.kind === "model") {
					await client.setSessionModel(nextValue);
				} else {
					await client.setSessionConfigOption(control.id, nextValue);
				}
			} catch (error) {
				console.error("[ACP] Failed to update session control:", error);
				toast(error?.message || "Failed to update session setting");
			} finally {
				isUpdatingSessionControl = false;
				renderSessionControls();
			}
		}

		async function openSessionControlPicker(control) {
			if (!client.session || isPrompting || isUpdatingSessionControl) return;
			if (!Array.isArray(control.choices) || !control.choices.length) return;

			try {
				const nextValue = await select(
					control.name,
					control.choices.map((choice) => ({
						value: choice.value,
						text: formatSelectLabel(choice),
					})),
					{
						default: control.currentValue,
						textTransform: false,
					},
				);
				if (!nextValue || nextValue === control.currentValue) return;
				await applySessionControl(control, nextValue);
			} catch (error) {
				if (!error) return;
				console.error("[ACP] Failed to open session control selector:", error);
				toast(error?.message || "Failed to open selector");
			}
		}

		function renderSessionControls() {
			withStableMessagesViewport(() => {
				const controls = toSessionControls();
				$sessionControls.innerHTML = "";

				if (!controls.length) {
					$sessionControls.classList.add("hidden");
					return;
				}

				$sessionControls.classList.remove("hidden");
				controls.forEach((control) => {
					const $button = (
						<button
							className="acp-session-control-btn"
							title={control.name}
							onclick={() => openSessionControlPicker(control)}
						>
							<span className="acp-session-control-text">
								{control.displayText}
							</span>
							<i className="icon arrow_drop_down"></i>
						</button>
					);
					$button.disabled =
						isPrompting ||
						isUpdatingSessionControl ||
						!client.session ||
						!control.choices.length;
					$sessionControls.append($button);
				});
			});
		}

		function toAttachmentName(selectedFile) {
			if (selectedFile?.name) return selectedFile.name;
			const target = String(selectedFile?.url || "");
			const maybeName = Url.basename(target);
			if (maybeName) return decodeURIComponent(maybeName);
			return "Attachment";
		}

		function extractByteSize(stat) {
			const candidates = [stat?.size, stat?.length, stat?.byteLength];
			for (const candidate of candidates) {
				if (Number.isFinite(candidate) && candidate >= 0) {
					return Number(candidate);
				}
			}
			return null;
		}

		function formatFileSize(size) {
			if (!Number.isFinite(size) || size <= 0) return "";
			try {
				return filesize(size);
			} catch {
				return "";
			}
		}

		function guessMimeType(name = "") {
			const resolvedType = mimeType.lookup(name);
			return typeof resolvedType === "string" ? resolvedType : "";
		}

		function normalizeMimeType(value = "") {
			if (typeof value !== "string") return "";
			const normalized = value.trim().toLowerCase();
			return normalized.includes("/") ? normalized : "";
		}

		function removeAttachment(index) {
			pendingAttachments.splice(index, 1);
			renderAttachmentPreview();
			updateSendButtonState();
		}

		function withStableMessagesViewport(updateComposer) {
			const $messagesEl = $chatView.querySelector(".acp-messages");
			if (!$messagesEl) {
				updateComposer();
				return;
			}
			const distanceFromBottom =
				$messagesEl.scrollHeight -
				$messagesEl.scrollTop -
				$messagesEl.clientHeight;

			updateComposer();

			requestAnimationFrame(() => {
				const $nextMessagesEl = $chatView.querySelector(".acp-messages");
				if (!$nextMessagesEl) return;
				const nextScrollTop =
					$nextMessagesEl.scrollHeight -
					$nextMessagesEl.clientHeight -
					distanceFromBottom;
				$nextMessagesEl.scrollTop = Math.max(0, nextScrollTop);
			});
		}

		function renderAttachmentPreview() {
			withStableMessagesViewport(() => {
				$attachmentPreview.innerHTML = "";
				if (!pendingAttachments.length) {
					$attachmentPreview.classList.add("hidden");
					return;
				}

				$attachmentPreview.classList.remove("hidden");
				pendingAttachments.forEach((attachment, index) => {
					const $chip = (
						<div className="acp-attachment-chip" title={attachment.uri}>
							<i className="icon attach_file"></i>
							<span className="acp-attachment-chip-name">
								{attachment.name}
							</span>
							<span className="acp-attachment-chip-size">
								{formatFileSize(attachment.size)}
							</span>
							<button
								className="acp-attachment-remove"
								title={`Remove ${attachment.name}`}
								onclick={() => removeAttachment(index)}
							>
								×
							</button>
						</div>
					);
					$attachmentPreview.append($chip);
				});
			});
		}

		function updateSendButtonState() {
			if (isPrompting) return;
			const hasText = Boolean($textarea.value.trim());
			const hasAttachments = pendingAttachments.length > 0;
			$sendBtn.disabled = !hasText && !hasAttachments;
		}

		function toResourceLinkBlock(attachment) {
			const block = {
				type: "resource_link",
				name: attachment.name,
				uri: attachment.uri,
			};
			if (attachment.mimeType) {
				block.mimeType = attachment.mimeType;
			}
			if (Number.isFinite(attachment.size) && attachment.size >= 0) {
				block.size = attachment.size;
			}
			return block;
		}

		function canSendImageBlocks() {
			return Boolean(client.agentCapabilities?.promptCapabilities?.image);
		}

		function canSendAudioBlocks() {
			return Boolean(client.agentCapabilities?.promptCapabilities?.audio);
		}

		function isImageMimeType(mime = "") {
			return mime.startsWith("image/");
		}

		function isAudioMimeType(mime = "") {
			return mime.startsWith("audio/");
		}

		async function toBase64Data(data, mime = "application/octet-stream") {
			if (typeof data === "string") {
				const dataUrlMatch = /^data:[^;]+;base64,(.+)$/i.exec(data);
				if (dataUrlMatch?.[1]) return dataUrlMatch[1];
				return null;
			}

			const blob =
				data instanceof Blob
					? data
					: new Blob([data], {
							type: mime || "application/octet-stream",
						});

			return await new Promise((resolve) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = String(reader.result || "");
					const base64 = result.split(",")[1] || "";
					resolve(base64 || null);
				};
				reader.onerror = () => resolve(null);
				reader.readAsDataURL(blob);
			});
		}

		async function toMediaContentBlock(attachment) {
			const mime = normalizeMimeType(attachment.mimeType);
			const canImage = canSendImageBlocks() && isImageMimeType(mime);
			const canAudio = canSendAudioBlocks() && isAudioMimeType(mime);
			if (!canImage && !canAudio) return null;

			if (
				Number.isFinite(attachment.size) &&
				attachment.size > MAX_INLINE_MEDIA_BYTES
			) {
				return null;
			}

			try {
				const rawData = await fsOperation(attachment.uri).readFile();
				const base64Data = await toBase64Data(rawData, mime);
				if (!base64Data) return null;

				if (canImage) {
					return {
						type: "image",
						mimeType: mime,
						data: base64Data,
						uri: attachment.uri,
					};
				}

				return {
					type: "audio",
					mimeType: mime,
					data: base64Data,
				};
			} catch {
				return null;
			}
		}

		async function getAttachmentContentBlocks() {
			const blocks = [];
			for (const attachment of pendingAttachments) {
				const mediaBlock = await toMediaContentBlock(attachment);
				if (mediaBlock) {
					blocks.push(mediaBlock);
				} else {
					blocks.push(toResourceLinkBlock(attachment));
				}
			}
			return blocks;
		}

		async function buildPromptContent(text) {
			const content = await getAttachmentContentBlocks();
			if (text) {
				content.push({ type: "text", text });
			}
			return content;
		}

		async function handleAttachContext() {
			if (isPrompting || isSelectingAttachment) return;

			isSelectingAttachment = true;
			try {
				const selectedFile = await FileBrowser("file", "Select file to attach");
				if (!selectedFile?.url) return;

				const uri = String(selectedFile.url);
				if (pendingAttachments.some((attachment) => attachment.uri === uri)) {
					toast("File already attached");
					return;
				}

				const name = toAttachmentName(selectedFile);
				let size = null;
				let detectedMimeType = "";
				try {
					const stat = await fsOperation(uri).stat();
					size = extractByteSize(stat);
					detectedMimeType =
						normalizeMimeType(stat?.mimeType) ||
						normalizeMimeType(stat?.mime) ||
						normalizeMimeType(stat?.type);
				} catch {
					// Keep attachment even if file metadata couldn't be read.
				}

				pendingAttachments.push({
					uri,
					name,
					size,
					mimeType: detectedMimeType || guessMimeType(name),
				});
				renderAttachmentPreview();
				updateSendButtonState();
			} catch (error) {
				if (error) {
					console.error("[ACP] Failed to attach context:", error);
					toast(error.message || "Failed to attach file");
				}
			} finally {
				isSelectingAttachment = false;
			}
		}

		async function handleSend() {
			const text = $textarea.value.trim();
			const hasAttachments = pendingAttachments.length > 0;
			if ((!text && !hasAttachments) || isPrompting) return;

			// Remove empty state when first message is sent
			if ($emptyState.parentNode) $emptyState.remove();

			const content = await buildPromptContent(text);

			$textarea.value = "";
			$textarea.style.height = "auto";
			pendingAttachments = [];
			renderAttachmentPreview();
			updateSendButtonState();

			setPrompting(true, { $sendBtn, $cancelBtn });

			try {
				const promptRequest = client.prompt(content);
				syncTimeline();
				await promptRequest;
			} catch (err) {
				console.error("[ACP] Prompt error:", err);
				toast(err?.message || "Failed to send prompt");
			} finally {
				saveCurrentSessionHistory();
				setPrompting(false, { $sendBtn, $cancelBtn });
				updateSendButtonState();
			}
		}

		const $view = (
			<div className="acp-chat-view">
				<div className="acp-chat-header">
					<div className="acp-header-left">
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
					<div className="acp-input-container">
						{$attachmentPreview}
						{$textarea}
						<div className="acp-input-toolbar">
							{$attachBtn}
							{$sessionControls}
							{$sendBtn}
							{$cancelBtn}
						</div>
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

		$view.resetComposer = () => {
			pendingAttachments = [];
			$textarea.value = "";
			$textarea.style.height = "auto";
			renderAttachmentPreview();
			updateSendButtonState();
			renderSessionControls();
		};

		$view.refreshComposerControls = () => {
			renderSessionControls();
		};

		updateSendButtonState();

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
			turnStops: session.turnStops || [],
			updatedAt: session.updatedAt || new Date().toISOString(),
		});
	}

	function restorePersistedTurnStops(historyEntry) {
		const session = client.session;
		if (!session || !historyEntry) return;
		const turnStops = Array.isArray(historyEntry.turnStops)
			? historyEntry.turnStops
			: [];
		if (!turnStops.length) return;
		session.setPersistedTurnStops(turnStops);
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
		const cwd = normalizeSessionCwd(entry.cwd || $form.getValues().cwd || "");
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
			client.session?.finishAgentTurn();
			currentSessionUrl = entry.url;
			setChatAgentName(entry.agentName || client.agentName);
			restorePersistedTurnStops(entry);
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
		if ($dot) {
			$dot.className = "acp-status-dot";
		}
		if ($ping) {
			$ping.className = "acp-status-ping";
		}

		if (state === "connected") {
			if ($dot) $dot.classList.add("connected");
			if ($ping) $ping.classList.add("connected");
			if ($label) $label.textContent = "Connected";
		} else if (state === "connecting") {
			if ($dot) $dot.classList.add("working");
			if ($ping) {
				$ping.classList.add("active", "working");
			}
			if ($label) $label.textContent = "Working…";
		} else if (state === "error") {
			if ($dot) $dot.classList.add("error");
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
		activePromptSessionId = value ? client.session?.sessionId || null : null;
		if (elements.$sendBtn) {
			elements.$sendBtn.style.display = value ? "none" : "flex";
		}
		if (elements.$cancelBtn) {
			elements.$cancelBtn.style.display = value ? "flex" : "none";
		}
		updateStatusDot(value ? "connecting" : "connected");
		$chatView.refreshComposerControls?.();
		if (currentView === "chat") {
			syncTimeline();
		}
	}

	// ─── Event Handlers ───
	function createTimelineElement(entry) {
		const cwd = client.session?.cwd || $form.getValues().cwd || "";
		switch (entry.type) {
			case "message":
				return ChatMessage({
					message: entry.message,
					cwd,
					isResponding:
						entry.message.role !== "user" && Boolean(entry.message.streaming),
				});
			case "tool_call":
				return ToolCallCard({ toolCall: entry.toolCall });
			case "plan":
				return PlanCard({ plan: entry.plan });
			case "turn_stop":
				return StopReasonCard({ turnStop: entry.turnStop });
			default:
				return null;
		}
	}

	function hasStreamingAgentMessage(entries) {
		return entries.some((entry) => {
			if (entry.type !== "message") return false;
			if (entry.message.role !== "agent" && entry.message.role !== "thought") {
				return false;
			}
			if (entry.message.streaming) {
				return true;
			}
			return false;
		});
	}

	function buildPendingTurnIndicator() {
		return (
			<div className="acp-pending-turn" title="Agent is responding">
				<span className="acp-pending-dot"></span>
				<span className="acp-pending-dot"></span>
				<span className="acp-pending-dot"></span>
				<span className="acp-pending-label">Responding…</span>
			</div>
		);
	}

	function syncPendingTurnIndicator($messages, entries) {
		const currentSessionId = client.session?.sessionId || null;
		const shouldShow =
			isPrompting &&
			Boolean(activePromptSessionId) &&
			activePromptSessionId === currentSessionId &&
			!hasStreamingAgentMessage(entries || []);

		if (!shouldShow) {
			if (pendingTurnIndicatorElement) {
				pendingTurnIndicatorElement.remove();
				pendingTurnIndicatorElement = null;
			}
			return;
		}

		if (!pendingTurnIndicatorElement) {
			pendingTurnIndicatorElement = buildPendingTurnIndicator();
		}

		// Always append so it stays as the latest item even as new entries stream in.
		$messages.append(pendingTurnIndicatorElement);
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
			const entryWithContext = {
				...entry,
				cwd: client.session?.cwd || $form.getValues().cwd || "",
				isResponding:
					entry.type === "message" &&
					entry.message.role !== "user" &&
					Boolean(entry.message.streaming),
			};
			if (timelineElements.has(entry.entryId)) {
				timelineElements.get(entry.entryId).update(entryWithContext);
			} else {
				const $entry = createTimelineElement(entry);
				if (!$entry) return;
				timelineElements.set(entry.entryId, $entry);
				$messages.append($entry);
			}
		});
		syncPendingTurnIndicator($messages, entries);

		$messages.scrollTop = $messages.scrollHeight;
		saveCurrentSessionHistory();
	}

	client.on("session_update", () => {
		syncTimeline();
	});

	client.on("session_controls_update", () => {
		$chatView.refreshComposerControls?.();
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
