import "./acp.scss";
import fsOperation from "fileSystem";
import { RequestError } from "@agentclientprotocol/sdk";
import Page from "components/page";
import toast from "components/toast";
import select from "dialogs/select";
import { filesize } from "filesize";
import { ACPClient } from "lib/acp/client";
import acpHistory from "lib/acp/history";
import { ConnectionState } from "lib/acp/models";
import actionStack from "lib/actionStack";
import files from "lib/fileList";
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
	const ACP_FS_READ_TEXT_FILE = "fs/read_text_file";
	const ACP_FS_WRITE_TEXT_FILE = "fs/write_text_file";

	registerFilesystemHandlers();

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

		const nextCwd = normalizeSessionCwd(cwd || "/home");
		$form.setValues({ url, cwd: nextCwd });
		$form.setConnecting(true);
		setFormStatus("");

		try {
			setFormStatus("Connecting...");
			await ensureReadyForUrl(url);
			setFormStatus("Starting session...");

			try {
				await client.newSession(nextCwd || undefined);
			} catch (sessionErr) {
				if (!ACPClient.isAuthRequiredError(sessionErr)) throw sessionErr;
				await handleAuthentication();
				await client.newSession(nextCwd || undefined);
			}

			currentSessionUrl = url;
			switchToChat(client.agentName);
			saveCurrentSessionHistory();
			syncTimeline();
		} catch (err) {
			$form.setConnecting(false);
			setFormStatus(err.message || "Connection failed");
		}
	}

	async function handleAuthentication() {
		const methods = client.authMethods;
		if (!methods.length) {
			throw new Error(
				"Agent requires authentication but did not advertise any auth methods.",
			);
		}

		let selectedMethod = methods[0];

		if (methods.length > 1) {
			setFormStatus("Authentication required — choose a method");
			const picked = await select(
				"Authentication Required",
				methods.map((m) => ({
					value: m.id,
					text: m.name + (m.description ? ` — ${m.description}` : ""),
					icon: "vpn_key",
				})),
				{ textTransform: false },
			);
			if (!picked) throw new Error("Authentication cancelled");
			selectedMethod = methods.find((m) => m.id === picked) || methods[0];
		}

		let browserOpened = false;
		const maybeOpenAuthUrl = (value) => {
			const url = extractExternalUrl(value);
			if (!url || browserOpened) return false;
			browserOpened = true;
			system.openInBrowser(url);
			setFormStatus("Complete sign-in in your browser…");
			return true;
		};

		const handleExtNotification = (event) => {
			maybeOpenAuthUrl(event);
		};
		const handleExtRequest = (event) => {
			maybeOpenAuthUrl(event);
		};
		const handleAuthExtRequest = async (method, params = {}) => {
			const didOpen = maybeOpenAuthUrl({ method, params });
			if (!didOpen) {
				throw RequestError.methodNotFound(method);
			}
			return {
				ok: true,
				handled: true,
				opened: true,
			};
		};

		const { alpineRoot } = getTerminalPaths();
		const urlTempPath = `file://${alpineRoot}/tmp/.acode_open_url`;
		try {
			await fsOperation(urlTempPath).delete();
		} catch {
			/* ignore */
		}

		setFormStatus(`Authenticating via ${selectedMethod.name}…`);

		client.setExtensionRequestHandler(handleAuthExtRequest);
		client.on("ext_request", handleExtRequest);
		client.on("ext_notification", handleExtNotification);
		const stopPolling = startAuthUrlPolling(urlTempPath);
		try {
			const response = await client.authenticate(selectedMethod.id);
			maybeOpenAuthUrl(response);
		} finally {
			stopPolling();
			client.setExtensionRequestHandler(null);
			client.off("ext_request", handleExtRequest);
			client.off("ext_notification", handleExtNotification);
		}

		setFormStatus("Authenticated — starting session…");
	}

	function startAuthUrlPolling(urlFilePath) {
		let stopped = false;
		let opened = false;

		const poll = async () => {
			while (!stopped) {
				await new Promise((resolve) => setTimeout(resolve, 400));
				if (stopped) break;
				try {
					const raw = await fsOperation(urlFilePath).readFile("utf8");
					const url = String(raw || "").trim();
					if (url && !opened) {
						opened = true;
						system.openInBrowser(url);
						setFormStatus("Complete sign-in in your browser…");
						try {
							await fsOperation(urlFilePath).delete();
						} catch {
							/* ignore */
						}
					}
				} catch {
					/* file doesn't exist yet */
				}
			}
		};

		void poll();

		return () => {
			stopped = true;
		};
	}

	function getTerminalPaths() {
		const packageName = window.BuildInfo?.packageName || "com.foxdebug.acode";
		const dataDir = `/data/user/0/${packageName}`;
		return {
			dataDir,
			alpineRoot: `${dataDir}/files/alpine`,
			publicDir: `${dataDir}/files/public`,
		};
	}

	function extractExternalUrl(value, visited = new Set()) {
		if (typeof value === "string") {
			const trimmed = value.trim();
			return /^(https?|ftps?|mailto|tel|sms|geo):/i.test(trimmed)
				? trimmed
				: "";
		}

		if (!value || typeof value !== "object") return "";
		if (visited.has(value)) return "";
		visited.add(value);

		if (Array.isArray(value)) {
			for (const entry of value) {
				const nestedUrl = extractExternalUrl(entry, visited);
				if (nestedUrl) return nestedUrl;
			}
			return "";
		}

		const prioritizedKeys = [
			"url",
			"uri",
			"href",
			"openUrl",
			"open_url",
			"browserUrl",
			"browser_url",
			"verificationUri",
			"verification_uri",
			"verificationUrl",
			"verification_url",
			"authorizationUrl",
			"authorization_url",
			"authorizeUrl",
			"authorize_url",
		];

		for (const key of prioritizedKeys) {
			if (!(key in value)) continue;
			const nestedUrl = extractExternalUrl(value[key], visited);
			if (nestedUrl) return nestedUrl;
		}

		for (const nestedValue of Object.values(value)) {
			const nestedUrl = extractExternalUrl(nestedValue, visited);
			if (nestedUrl) return nestedUrl;
		}

		return "";
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

	function getSessionCwdForFs(sessionId = "") {
		const activeSession = client.session;
		if (activeSession?.sessionId === sessionId) {
			return normalizeSessionCwd(activeSession.cwd || "");
		}
		return normalizeSessionCwd($form.getValues().cwd || "");
	}

	function resolveAgentPath(path = "", sessionId = "") {
		const normalizedPath = normalizePathInput(path);
		if (!normalizedPath) return "";

		const sessionCwd = getSessionCwdForFs(sessionId);
		const protocol = Url.getProtocol(normalizedPath);

		if (protocol) {
			if (protocol === "file:") {
				return normalizedPath;
			}
			if (
				protocol === "content:" ||
				protocol === "ftp:" ||
				protocol === "sftp:" ||
				protocol === "http:" ||
				protocol === "https:"
			) {
				return normalizedPath;
			}
			return "";
		}

		const agentPath = normalizedPath.startsWith("/")
			? normalizedPath
			: sessionCwd
				? Url.join(sessionCwd, normalizedPath)
				: "";
		if (!agentPath) return "";

		const { alpineRoot, publicDir } = getTerminalPaths();
		if (agentPath === "~") {
			return `file://${alpineRoot}/home`;
		}
		if (agentPath.startsWith("~/")) {
			return `file://${alpineRoot}/home/${agentPath.slice(2)}`;
		}
		if (agentPath === "/public" || agentPath.startsWith("/public/")) {
			const suffix = agentPath.slice("/public".length);
			return `file://${publicDir}${suffix}`;
		}
		if (agentPath === "/home" || agentPath.startsWith("/home/")) {
			return `file://${alpineRoot}${agentPath}`;
		}
		if (
			agentPath.startsWith("/sdcard") ||
			agentPath.startsWith("/storage") ||
			agentPath.startsWith("/data")
		) {
			return `file://${agentPath}`;
		}
		if (agentPath.startsWith("/")) {
			return `file://${alpineRoot}${agentPath}`;
		}

		return "";
	}

	function normalizeFsReadRange(value, { name, min = 1 } = {}) {
		if (value == null) return null;
		const num = Number(value);
		if (!Number.isInteger(num) || num < min) {
			throw RequestError.invalidParams(
				{},
				`${name || "value"} must be an integer >= ${min}`,
			);
		}
		return num;
	}

	function sliceTextByLineRange(text = "", line, limit) {
		if (line == null && limit == null) return text;
		const allLines = String(text).split(/\r\n|\n|\r/);
		const startLine = line || 1;
		if (startLine > allLines.length) return "";
		if (limit === 0) return "";
		if (limit == null) {
			return allLines.slice(startLine - 1).join("\n");
		}
		return allLines.slice(startLine - 1, startLine - 1 + limit).join("\n");
	}

	function getOpenEditorFile(uri = "") {
		const manager = window.editorManager;
		if (!manager?.getFile || !uri) return null;
		const candidates = [uri];
		try {
			const decoded = decodeURIComponent(uri);
			if (decoded && !candidates.includes(decoded)) candidates.push(decoded);
		} catch {
			/* ignore */
		}

		for (const candidate of candidates) {
			const file = manager.getFile(candidate, "uri");
			if (file) return file;
		}
		return null;
	}

	async function readFileTextFromFs(resolvedPath = "") {
		const openFileRef = getOpenEditorFile(resolvedPath);
		const unsavedContent = openFileRef?.session?.getValue?.();
		if (typeof unsavedContent === "string") {
			return unsavedContent;
		}

		const content = await fsOperation(resolvedPath).readFile("utf8");
		if (typeof content === "string") return content;
		if (content instanceof ArrayBuffer) {
			return new TextDecoder().decode(content);
		}
		return String(content ?? "");
	}

	async function writeFileTextToFs(resolvedPath = "", content = "") {
		const targetFs = fsOperation(resolvedPath);
		const exists = await targetFs.exists();
		if (exists) {
			await targetFs.writeFile(content, "utf8");
		} else {
			const parentPath = Url.dirname(resolvedPath);
			const filename = Url.basename(resolvedPath);
			if (!parentPath || !filename) {
				throw RequestError.invalidParams(
					{},
					`Invalid file path: ${resolvedPath}`,
				);
			}
			await fsOperation(parentPath).createFile(filename, content);
		}

		const openFileRef = getOpenEditorFile(resolvedPath);
		if (openFileRef?.type === "editor") {
			openFileRef.session?.setValue?.(content);
			openFileRef.isUnsaved = false;
			openFileRef.markChanged = false;
			await openFileRef.writeToCache?.();
		}
	}

	function assertValidSessionRequest(sessionId = "") {
		const activeSessionId = client.session?.sessionId;
		if (!sessionId || !activeSessionId || sessionId !== activeSessionId) {
			throw RequestError.invalidParams({}, "Invalid or inactive sessionId");
		}
	}

	function toFsError(error, requestPath = "") {
		const message = String(error?.message || error || "");
		if (error instanceof RequestError) {
			return error;
		}
		if (
			/not found|no such file|path not found|does not exist|failed to resolve/i.test(
				message,
			)
		) {
			return RequestError.resourceNotFound(requestPath || undefined);
		}
		return RequestError.internalError(
			{},
			message || "Filesystem operation failed",
		);
	}

	function registerFilesystemHandlers() {
		client.registerRequestHandler(
			ACP_FS_READ_TEXT_FILE,
			async (params = {}) => {
				try {
					const sessionId = String(params?.sessionId || "");
					assertValidSessionRequest(sessionId);

					const rawPath = normalizePathInput(params?.path || "");
					if (!rawPath) {
						throw RequestError.invalidParams({}, "path is required");
					}

					const line = normalizeFsReadRange(params?.line, {
						name: "line",
						min: 1,
					});
					const limit = normalizeFsReadRange(params?.limit, {
						name: "limit",
						min: 0,
					});
					const resolvedPath = resolveAgentPath(rawPath, sessionId);
					if (!resolvedPath) {
						throw RequestError.invalidParams(
							{},
							`Unsupported filesystem path: ${rawPath}`,
						);
					}

					const text = await readFileTextFromFs(resolvedPath);
					return {
						content: sliceTextByLineRange(text, line, limit),
					};
				} catch (error) {
					throw toFsError(error, params?.path);
				}
			},
		);

		client.registerRequestHandler(
			ACP_FS_WRITE_TEXT_FILE,
			async (params = {}) => {
				try {
					const sessionId = String(params?.sessionId || "");
					assertValidSessionRequest(sessionId);

					const rawPath = normalizePathInput(params?.path || "");
					if (!rawPath) {
						throw RequestError.invalidParams({}, "path is required");
					}
					if (typeof params?.content !== "string") {
						throw RequestError.invalidParams({}, "content must be a string");
					}

					const resolvedPath = resolveAgentPath(rawPath, sessionId);
					if (!resolvedPath) {
						throw RequestError.invalidParams(
							{},
							`Unsupported filesystem path: ${rawPath}`,
						);
					}

					await writeFileTextToFs(resolvedPath, params.content);
					return {};
				} catch (error) {
					throw toFsError(error, params?.path);
				}
			},
		);
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
		let activeComposerHints = [];
		let activeComposerHintIndex = 0;
		let activeComposerTrigger = null;
		let composerHintsRequestId = 0;
		let currentCwdMentionCache = {
			cwd: "",
			items: [],
		};
		const ACP_BROWSE_FILE_OPTION = "__acp_browse_file__";
		const ACP_EMPTY_HINT_OPTION = "__acp_empty_hint__";
		const COMPOSER_MENTION_SELECTOR = ".acp-inline-mention-token";

		function sanitizeInlineAttachmentLabel(value = "") {
			const normalized = String(value || "")
				.trim()
				.replace(/^@+/, "")
				.replace(/[\[\]\(\)]/g, " ")
				.replace(/\s+/g, " ");
			return normalized || "Attachment";
		}

		function getComposerSelection() {
			const selection = window.getSelection();
			if (!selection?.rangeCount) return null;
			const range = selection.getRangeAt(0);
			if (!$editor.contains(range.endContainer)) return null;
			return {
				selection,
				range,
			};
		}

		function focusComposerAtNode(node, offset = 0) {
			const selection = window.getSelection();
			if (!selection) return;
			const range = document.createRange();
			range.setStart(node, offset);
			range.collapse(true);
			selection.removeAllRanges();
			selection.addRange(range);
			$editor.focus();
		}

		function getOrCreateEditableTextNode() {
			const lastChild = $editor.lastChild;
			if (lastChild?.nodeType === Node.TEXT_NODE) {
				return lastChild;
			}
			const textNode = document.createTextNode("");
			$editor.append(textNode);
			return textNode;
		}

		function normalizeIndexedUri(value = "") {
			return String(value || "")
				.trim()
				.replace(/\/+$/, "")
				.toLowerCase();
		}

		function isUriWithinScope(uri = "", scope = "") {
			const normalizedUri = normalizeIndexedUri(uri);
			const normalizedScope = normalizeIndexedUri(scope);
			if (!normalizedUri || !normalizedScope) return false;
			return (
				normalizedUri === normalizedScope ||
				normalizedUri.startsWith(`${normalizedScope}/`)
			);
		}

		function toIndexedHintItem(item, source = "Workspace index") {
			if (!item?.url) return null;
			const isDirectory = Array.isArray(item.children);
			return toFileHintItem({
				uri: item.url,
				name: item.name,
				path: item.path || item.url,
				description: isDirectory
					? "Folder from workspace index"
					: "File from workspace index",
				source,
				icon: isDirectory ? "folder" : "attach_file",
			});
		}

		function collectIndexedDirectoryItems(tree) {
			if (!tree) return [];
			const children = Array.isArray(tree.children) ? tree.children : null;
			if (!children?.length) {
				const item = toIndexedHintItem(tree);
				return item ? [item] : [];
			}
			return children
				.map((child) => toIndexedHintItem(child))
				.filter(Boolean)
				.sort((a, b) => {
					const directoryRankA = a.icon === "folder" ? 0 : 1;
					const directoryRankB = b.icon === "folder" ? 0 : 1;
					if (directoryRankA !== directoryRankB) {
						return directoryRankA - directoryRankB;
					}
					return a.label.localeCompare(b.label);
				});
		}

		function collectIndexedTreeItems(tree, items = [], depth = 0) {
			if (!tree) return items;
			const children = Array.isArray(tree.children) ? tree.children : null;
			if (!children?.length) {
				const item = toIndexedHintItem(tree);
				if (item) {
					items.push({
						...item,
						sortDepth: depth,
					});
				}
				return items;
			}
			children.forEach((child) => {
				const childItem = toIndexedHintItem(child);
				if (childItem) {
					items.push({
						...childItem,
						sortDepth: depth,
					});
				}
				collectIndexedTreeItems(child, items, depth + 1);
			});
			return items;
		}

		function getComposerTriggerState() {
			const selectionState = getComposerSelection();
			if (!selectionState) return null;

			let { endContainer, endOffset } = selectionState.range;
			if (endContainer.nodeType !== Node.TEXT_NODE) {
				const candidate =
					endContainer.childNodes?.[Math.max(0, endOffset - 1)] ||
					endContainer.lastChild ||
					null;
				if (candidate?.nodeType === Node.TEXT_NODE) {
					endContainer = candidate;
					endOffset = candidate.textContent?.length || 0;
				} else {
					return null;
				}
			}

			const textNode = endContainer;
			const beforeCursor = String(textNode.textContent || "").slice(
				0,
				endOffset,
			);
			const triggerMatch = /(^|\s)([@/])([^\s]*)$/.exec(beforeCursor);
			if (!triggerMatch) return null;

			const trigger = triggerMatch[2];
			const query = triggerMatch[3] || "";
			return {
				trigger,
				query,
				node: textNode,
				startOffset: endOffset - query.length - 1,
				endOffset,
			};
		}

		function replaceComposerTrigger(triggerState, replacement = "") {
			if (!triggerState?.node) return null;
			const textNode = triggerState.node;
			const text = String(textNode.textContent || "");
			const before = text.slice(0, triggerState.startOffset);
			const after = text.slice(triggerState.endOffset);
			textNode.textContent = `${before}${replacement}${after}`;
			const nextOffset = before.length + replacement.length;
			focusComposerAtNode(textNode, nextOffset);
			$editor.dispatchEvent(new Event("input"));
			return textNode;
		}

		function insertComposerText(text = "") {
			const selectionState = getComposerSelection();
			if (!selectionState) {
				const textNode = getOrCreateEditableTextNode();
				textNode.textContent += text;
				focusComposerAtNode(textNode, textNode.textContent.length);
				$editor.dispatchEvent(new Event("input"));
				return;
			}

			const { selection, range } = selectionState;
			range.deleteContents();
			const textNode = document.createTextNode(text);
			range.insertNode(textNode);
			range.setStart(textNode, textNode.textContent.length);
			range.collapse(true);
			selection.removeAllRanges();
			selection.addRange(range);
			$editor.dispatchEvent(new Event("input"));
		}

		function insertComposerLineBreak() {
			const selectionState = getComposerSelection();
			if (!selectionState) {
				const textNode = getOrCreateEditableTextNode();
				textNode.parentNode?.insertBefore(
					document.createElement("br"),
					textNode,
				);
				focusComposerAtNode(textNode, 0);
				$editor.dispatchEvent(new Event("input"));
				return;
			}

			const { selection, range } = selectionState;
			range.deleteContents();
			const lineBreak = document.createElement("br");
			const spacer = document.createTextNode("");
			range.insertNode(spacer);
			range.insertNode(lineBreak);
			range.setStart(spacer, 0);
			range.collapse(true);
			selection.removeAllRanges();
			selection.addRange(range);
			$editor.dispatchEvent(new Event("input"));
		}

		function getAdjacentMentionToken(direction = "backward") {
			const selectionState = getComposerSelection();
			if (!selectionState?.range?.collapsed) return null;

			let { endContainer, endOffset } = selectionState.range;
			if (endContainer instanceof HTMLElement) {
				const token = endContainer.closest(COMPOSER_MENTION_SELECTOR);
				if (token) return token;
			}

			if (endContainer.nodeType === Node.TEXT_NODE) {
				const text = String(endContainer.textContent || "");
				if (direction === "backward" && endOffset !== 0) return null;
				if (direction === "forward" && endOffset !== text.length) return null;
				const sibling =
					direction === "backward"
						? endContainer.previousSibling
						: endContainer.nextSibling;
				return sibling instanceof HTMLElement &&
					sibling.matches(COMPOSER_MENTION_SELECTOR)
					? sibling
					: null;
			}

			if (!(endContainer instanceof HTMLElement)) return null;
			const childIndex = direction === "backward" ? endOffset - 1 : endOffset;
			const sibling = endContainer.childNodes?.[childIndex] || null;
			return sibling instanceof HTMLElement &&
				sibling.matches(COMPOSER_MENTION_SELECTOR)
				? sibling
				: null;
		}

		function removeInlineMentionToken(token, direction = "backward") {
			if (!(token instanceof HTMLElement)) return false;
			const focusNode =
				direction === "backward" ? token.previousSibling : token.nextSibling;
			token.remove();
			const textNode =
				focusNode?.nodeType === Node.TEXT_NODE
					? focusNode
					: getOrCreateEditableTextNode();
			const nextOffset =
				direction === "backward" ? textNode.textContent?.length || 0 : 0;
			focusComposerAtNode(textNode, nextOffset);
			$editor.dispatchEvent(new Event("input"));
			return true;
		}

		function createInlineMentionToken(attachment) {
			const $icon = attachment.iconClass
				? <span className={`${attachment.iconClass} acp-file-icon`}></span>
				: <i className={`icon ${attachment.icon || "attach_file"}`}></i>;
			const $token = (
				<span
					className="acp-inline-mention-token"
					contenteditable="false"
					data-uri={attachment.uri}
					data-name={sanitizeInlineAttachmentLabel(attachment.name)}
					data-mime-type={attachment.mimeType || ""}
					data-size={
						Number.isFinite(attachment.size) && attachment.size >= 0
							? String(attachment.size)
							: ""
					}
					data-icon-class={attachment.iconClass || ""}
					data-icon={attachment.icon || "attach_file"}
					title={attachment.uri}
				>
					{$icon}
					<span className="acp-inline-mention-token-name">
						{sanitizeInlineAttachmentLabel(attachment.name)}
					</span>
					<button
						type="button"
						className="acp-inline-mention-token-remove"
						tabindex="-1"
						onmousedown={(event) => {
							event.preventDefault();
							removeInlineMentionToken($token, "forward");
						}}
					>
						<i className="icon clearclose"></i>
					</button>
				</span>
			);
			$token.contentEditable = "false";
			return $token;
		}

		function insertInlineMentionToken(attachment, triggerState = null) {
			const currentTrigger = triggerState || activeComposerTrigger;
			if (!attachment?.uri || !currentTrigger?.node) return;

			const textNode = currentTrigger.node;
			const text = String(textNode.textContent || "");
			const before = text.slice(0, currentTrigger.startOffset);
			const after = text.slice(currentTrigger.endOffset);
			const afterNode = document.createTextNode(after);
			const tokenNode = createInlineMentionToken(attachment);

			textNode.textContent = before;
			textNode.parentNode?.insertBefore(tokenNode, textNode.nextSibling);
			textNode.parentNode?.insertBefore(afterNode, tokenNode.nextSibling);
			focusComposerAtNode(afterNode, 0);
			$editor.dispatchEvent(new Event("input"));
		}

		function serializeComposerBlocks() {
			const blocks = [];
			const appendText = (value = "") => {
				if (!value) return;
				const lastBlock = blocks[blocks.length - 1];
				if (lastBlock?.type === "text") {
					lastBlock.text += value;
					return;
				}
				blocks.push({
					type: "text",
					text: value,
				});
			};

			Array.from($editor.childNodes).forEach((node) => {
				if (node.nodeType === Node.TEXT_NODE) {
					appendText(node.textContent || "");
					return;
				}
				if (!(node instanceof HTMLElement)) return;
				if (node.matches(COMPOSER_MENTION_SELECTOR)) {
					blocks.push({
						type: "resource_link",
						name: sanitizeInlineAttachmentLabel(node.dataset.name || ""),
						uri: String(node.dataset.uri || ""),
						mimeType: node.dataset.mimeType || undefined,
						size: node.dataset.size ? Number(node.dataset.size) : undefined,
					});
					return;
				}
				if (node.tagName === "BR") {
					appendText("\n");
				}
			});

			return blocks.filter((block) => {
				return block.type !== "text" || block.text.length > 0;
			});
		}

		function getComposerPlainText() {
			return serializeComposerBlocks()
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
		}

		function toFileHintItem({
			uri = "",
			name = "",
			path = "",
			description = "",
			source = "",
			icon = "attach_file",
		}) {
			if (!uri) return null;
			const label = sanitizeInlineAttachmentLabel(
				name || Url.basename(uri) || uri,
			);
			const subText = description || path || uri;
			return {
				id: uri,
				type: "mention",
				value: uri,
				label,
				subText,
				source,
				icon,
			};
		}

		function getActiveComposerCwd() {
			return client.session?.cwd || $form.getValues().cwd || "";
		}

		async function getCurrentCwdMentionItems() {
			const cwd = String(getActiveComposerCwd() || "").trim();
			if (!cwd) return [];
			if (currentCwdMentionCache.cwd === cwd) {
				return currentCwdMentionCache.items;
			}

			try {
				const resolvedCwd = resolveAgentPath(
					cwd,
					client.session?.sessionId || "",
				);
				if (!resolvedCwd) {
					currentCwdMentionCache = {
						cwd,
						items: [],
					};
					return [];
				}
				const entries = await fsOperation(resolvedCwd).lsDir();
				const items = (Array.isArray(entries) ? entries : [])
					.map((entry) => {
						const entryUri = String(entry?.url || "");
						if (!entryUri) return null;
						const isDirectory = Boolean(entry?.isDirectory);
						return toFileHintItem({
							uri: entryUri,
							name: entry?.name || Url.basename(entryUri) || entryUri,
							path: entryUri,
							description: isDirectory
								? "Folder in current cwd"
								: "File in current cwd",
							source: isDirectory ? "Current cwd folder" : "Current cwd file",
							icon: isDirectory ? "folder" : "attach_file",
						});
					})
					.filter(Boolean)
					.sort((a, b) => {
						const directoryRankA = a.source?.includes("folder") ? 0 : 1;
						const directoryRankB = b.source?.includes("folder") ? 0 : 1;
						if (directoryRankA !== directoryRankB)
							return directoryRankA - directoryRankB;
						return a.label.localeCompare(b.label);
					});

				currentCwdMentionCache = {
					cwd,
					items,
				};
				return items;
			} catch {
				currentCwdMentionCache = {
					cwd,
					items: [],
				};
				return [];
			}
		}

		async function getMentionItems(query = "") {
			const normalizedQuery = String(query || "")
				.trim()
				.toLowerCase();
			const seen = new Set();
			const results = [];
			const pushItem = (item) => {
				if (!item?.value || seen.has(item.value)) return;
				if (
					normalizedQuery &&
					![item.label, item.subText, item.value, item.source]
						.filter(Boolean)
						.some((value) =>
							String(value).toLowerCase().includes(normalizedQuery),
						)
				) {
					return;
				}
				seen.add(item.value);
				results.push(item);
			};

			const indexedWorkspaceItems = [];
			const activeCwd = String(getActiveComposerCwd() || "").trim();
			const resolvedCwd = activeCwd
				? resolveAgentPath(activeCwd, client.session?.sessionId || "")
				: "";
			try {
				if (resolvedCwd) {
					const cwdTree = files(resolvedCwd);
					if (cwdTree) {
						const directItems = collectIndexedDirectoryItems(cwdTree);
						const recursiveItems = collectIndexedTreeItems(cwdTree).sort(
							(a, b) => {
								if ((a.sortDepth || 0) !== (b.sortDepth || 0)) {
									return (a.sortDepth || 0) - (b.sortDepth || 0);
								}
								const directoryRankA = a.icon === "folder" ? 0 : 1;
								const directoryRankB = b.icon === "folder" ? 0 : 1;
								if (directoryRankA !== directoryRankB) {
									return directoryRankA - directoryRankB;
								}
								return a.label.localeCompare(b.label);
							},
						);
						indexedWorkspaceItems.push(...directItems, ...recursiveItems);
					}
				}

				if (!indexedWorkspaceItems.length) {
					files((item) => {
						if (!item?.url) return item;
						if (resolvedCwd && !isUriWithinScope(item.url, resolvedCwd)) {
							return item;
						}
						const hint = toFileHintItem({
							uri: item.url,
							name: item.name,
							path: item.path || item.url,
							source: "Workspace index",
							icon: "attach_file",
						});
						if (hint) {
							indexedWorkspaceItems.push(hint);
						}
						return item;
					});
				}
			} catch {
				// Ignore file index failures.
			}

			if (indexedWorkspaceItems.length) {
				indexedWorkspaceItems.forEach((item) => {
					pushItem(item);
				});

				const openFiles = Array.isArray(window.editorManager?.files)
					? window.editorManager.files
					: [];
				openFiles.forEach((file) => {
					const uri = String(file?.uri || "");
					if (!uri) return;
					pushItem(
						toFileHintItem({
							uri,
							name: file?.filename || file?.name,
							path: file?.location || uri,
							source: "Open file",
							icon: "attach_file",
						}),
					);
				});
			} else {
				(await getCurrentCwdMentionItems()).forEach((item) => {
					pushItem(item);
				});

				const openFiles = Array.isArray(window.editorManager?.files)
					? window.editorManager.files
					: [];
				openFiles.forEach((file) => {
					const uri = String(file?.uri || "");
					if (!uri) return;
					pushItem(
						toFileHintItem({
							uri,
							name: file?.filename || file?.name,
							path: file?.location || uri,
							source: "Open file",
							icon: "code",
						}),
					);
				});
			}

			results.sort((a, b) => {
				const sourceOrderA = a.source === "Open file" ? 0 : 1;
				const sourceOrderB = b.source === "Open file" ? 0 : 1;
				if (sourceOrderA !== sourceOrderB) return sourceOrderA - sourceOrderB;
				return a.label.localeCompare(b.label);
			});

			results.unshift({
				id: ACP_BROWSE_FILE_OPTION,
				type: "mention_browse",
				value: ACP_BROWSE_FILE_OPTION,
				label: "Browse files…",
				subText: "Pick any file from storage",
				icon: "folder_open",
			});

			return results.slice(0, 60);
		}

		function getSlashCommandItems(query = "") {
			const normalizedQuery = String(query || "")
				.trim()
				.toLowerCase();
			const availableCommands = Array.isArray(client.session?.availableCommands)
				? client.session.availableCommands
				: [];
			return availableCommands
				.map((command) => {
					const name = String(command?.name || "").trim();
					if (!name) return null;
					const description = String(command?.description || "").trim();
					const searchable = [name, description].join(" ").toLowerCase();
					if (normalizedQuery && !searchable.includes(normalizedQuery)) {
						return null;
					}
					return {
						id: name,
						type: "slash",
						value: name,
						label: `/${name}`,
						subText: description || "Slash command",
						icon: "code",
					};
				})
				.filter(Boolean)
				.slice(0, 30);
		}

		function hideComposerHints() {
			activeComposerHints = [];
			activeComposerHintIndex = 0;
			activeComposerTrigger = null;
			$composerHints.innerHTML = "";
			$composerHints.classList.add("hidden");
		}

		function renderComposerHints() {
			$composerHints.innerHTML = "";
			if (!activeComposerHints.length || !activeComposerTrigger) {
				$composerHints.classList.add("hidden");
				return;
			}

			const $header = (
				<div className="acp-composer-hints-header">
					{activeComposerTrigger.trigger === "@"
						? "Add file context"
						: "Slash commands"}
				</div>
			);
			$composerHints.append($header);

			activeComposerHints.forEach((item, index) => {
				const isDisabled = item.type === "empty";
				const $item = (
					<button
						className={`acp-composer-hint${index === activeComposerHintIndex ? " active" : ""}`}
						type="button"
						disabled={isDisabled}
						onmousedown={(event) => {
							if (isDisabled) return;
							event.preventDefault();
							void applyComposerHint(item);
						}}
					>
						<span className={`icon acp-composer-hint-icon ${item.icon}`}></span>
						<span className="acp-composer-hint-copy">
							<span className="acp-composer-hint-topline">
								<span className="acp-composer-hint-title">{item.label}</span>
								{item.source
									? <span className="acp-composer-hint-source">
											{item.source}
										</span>
									: null}
							</span>
							<span className="acp-composer-hint-subtitle">{item.subText}</span>
						</span>
					</button>
				);
				$composerHints.append($item);
			});

			$composerHints.classList.remove("hidden");
		}

		async function refreshComposerHints() {
			const requestId = ++composerHintsRequestId;
			const triggerState = getComposerTriggerState();
			if (!triggerState) {
				hideComposerHints();
				return;
			}

			const nextHints =
				triggerState.trigger === "@"
					? await getMentionItems(triggerState.query)
					: getSlashCommandItems(triggerState.query);

			if (requestId !== composerHintsRequestId) {
				return;
			}

			activeComposerTrigger = triggerState;
			activeComposerHints = nextHints.length
				? nextHints
				: [
						{
							id: ACP_EMPTY_HINT_OPTION,
							type: "empty",
							value: "",
							label:
								triggerState.trigger === "@"
									? "No matching files"
									: "No slash commands advertised",
							subText:
								triggerState.trigger === "@"
									? "Try a different name or browse files"
									: "This agent has not sent available commands yet",
							icon: "info",
						},
					];
			activeComposerHintIndex = Math.min(
				activeComposerHintIndex,
				activeComposerHints.length - 1,
			);
			renderComposerHints();
		}

		function moveComposerHintSelection(direction) {
			if (!activeComposerHints.length) return;
			const lastIndex = activeComposerHints.length - 1;
			if (direction > 0) {
				activeComposerHintIndex =
					activeComposerHintIndex >= lastIndex
						? 0
						: activeComposerHintIndex + 1;
			} else {
				activeComposerHintIndex =
					activeComposerHintIndex <= 0
						? lastIndex
						: activeComposerHintIndex - 1;
			}
			renderComposerHints();
			const $activeHint = $composerHints.querySelector(
				".acp-composer-hint.active",
			);
			$activeHint?.scrollIntoView?.({
				block: "nearest",
			});
		}

		async function resolveAttachmentForUri(uri, preferredName = "") {
			const normalizedUri = String(uri || "");
			if (!normalizedUri) return null;
			let size = null;
			let detectedMimeType = "";
			try {
				const stat = await fsOperation(normalizedUri).stat();
				size = extractByteSize(stat);
				detectedMimeType =
					normalizeMimeType(stat?.mimeType) ||
					normalizeMimeType(stat?.mime) ||
					normalizeMimeType(stat?.type);
			} catch {
				// Keep attachment metadata best-effort only.
			}
			return {
				uri: normalizedUri,
				name:
					sanitizeInlineAttachmentLabel(preferredName) ||
					toAttachmentName({ url: normalizedUri }),
				size,
				mimeType:
					detectedMimeType || guessMimeType(preferredName || normalizedUri),
				iconClass: helpers.getIconForFile(
					preferredName || Url.basename(normalizedUri) || normalizedUri,
				),
			};
		}

		function clearCurrentCwdMentionCache() {
			currentCwdMentionCache = {
				cwd: "",
				items: [],
			};
		}

		function insertSlashCommand(commandName = "", triggerState = null) {
			const currentTrigger = triggerState || activeComposerTrigger;
			if (!currentTrigger) return;
			const nextName = String(commandName || "")
				.trim()
				.replace(/^\/+/, "");
			if (!nextName) return;
			replaceComposerTrigger(currentTrigger, `/${nextName} `);
		}

		async function applyComposerHint(item) {
			if (!item) return;
			const triggerState = activeComposerTrigger
				? { ...activeComposerTrigger }
				: null;
			hideComposerHints();
			if (item.type === "empty") return;
			if (item.type === "slash") {
				insertSlashCommand(item.value, triggerState);
				return;
			}
			try {
				let attachment;
				if (item.type === "mention_browse") {
					const selectedFile = await FileBrowser(
						"file",
						"Select file to mention",
					);
					if (!selectedFile?.url) return;
					attachment = await resolveAttachmentForUri(
						String(selectedFile.url),
						toAttachmentName(selectedFile),
					);
					if (attachment) {
						attachment.source = "Picked file";
						attachment.icon = "attach_file";
					}
				} else {
					attachment = await resolveAttachmentForUri(item.value, item.label);
					if (attachment) {
						attachment.source = item.source || "Context";
						attachment.icon = item.icon || "attach_file";
					}
				}
				if (!attachment) return;
				insertInlineMentionToken(attachment, triggerState);
			} catch (error) {
				if (!error) return;
				console.error("[ACP] Failed to insert inline mention:", error);
				toast(error?.message || "Failed to add file reference");
			}
		}

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
			$editor.textContent = text;
			const textNode = getOrCreateEditableTextNode();
			focusComposerAtNode(textNode, textNode.textContent.length);
			updateSendButtonState();
			void refreshComposerHints();
			handleSend();
		}

		const $editor = <div className="acp-editor"></div>;
		const $composerHints = <div className="acp-composer-hints hidden"></div>;
		$editor.setAttribute("contenteditable", "true");
		$editor.tabIndex = 0;
		$editor.setAttribute("role", "textbox");
		$editor.setAttribute("aria-multiline", "true");
		$editor.dataset.placeholder = "Message agent…";
		$editor.spellcheck = false;
		$editor.contentEditable = "true";
		$editor.addEventListener("input", () => {
			if ($editor.innerHTML === "<br>") {
				$editor.innerHTML = "";
				getOrCreateEditableTextNode();
			}
			updateSendButtonState();
			void refreshComposerHints();
		});
		$editor.addEventListener("keydown", (event) => {
			if (activeComposerHints.length && event.key === "ArrowDown") {
				event.preventDefault();
				moveComposerHintSelection(1);
				return;
			}
			if (activeComposerHints.length && event.key === "ArrowUp") {
				event.preventDefault();
				moveComposerHintSelection(-1);
				return;
			}
			if (
				activeComposerHints.length &&
				(event.key === "Enter" || event.key === "Tab")
			) {
				event.preventDefault();
				void applyComposerHint(
					activeComposerHints[activeComposerHintIndex] || null,
				);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				hideComposerHints();
				return;
			}
			if (event.key === "Backspace") {
				const token = getAdjacentMentionToken("backward");
				if (removeInlineMentionToken(token, "backward")) {
					event.preventDefault();
					return;
				}
			}
			if (event.key === "Delete") {
				const token = getAdjacentMentionToken("forward");
				if (removeInlineMentionToken(token, "forward")) {
					event.preventDefault();
					return;
				}
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				handleSend();
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				insertComposerLineBreak();
			}
		});
		$editor.addEventListener("paste", (event) => {
			event.preventDefault();
			const text = event.clipboardData?.getData("text/plain") || "";
			insertComposerText(text);
		});
		$editor.addEventListener("click", () => {
			if (!$editor.firstChild) {
				const textNode = getOrCreateEditableTextNode();
				focusComposerAtNode(textNode, textNode.textContent.length);
			}
			void refreshComposerHints();
		});
		$editor.addEventListener("keyup", () => {
			void refreshComposerHints();
		});
		$editor.addEventListener("blur", () => {
			setTimeout(() => {
				const activeElement = document.activeElement;
				const stillFocused =
					activeElement === $editor || $composerHints.contains(activeElement);
				if (!stillFocused) {
					hideComposerHints();
				}
			}, 0);
		});

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
			const hasText = Boolean(getComposerPlainText().trim());
			const hasAttachments = pendingAttachments.length > 0;
			const hasInlineMentions = Boolean(
				$editor.querySelector(COMPOSER_MENTION_SELECTOR),
			);
			$sendBtn.disabled = !hasText && !hasAttachments && !hasInlineMentions;
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
			const content = [];
			const inlineBlocks = serializeComposerBlocks();
			for (const block of inlineBlocks) {
				if (block.type === "text") {
					content.push(block);
					continue;
				}
				const attachment = await resolveAttachmentForUri(block.uri, block.name);
				content.push(attachment ? toResourceLinkBlock(attachment) : block);
			}
			content.push(...(await getAttachmentContentBlocks()));
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
			const rawText = getComposerPlainText();
			const text = rawText.trim();
			const hasAttachments = pendingAttachments.length > 0;
			const hasInlineMentions = Boolean(
				$editor.querySelector(COMPOSER_MENTION_SELECTOR),
			);
			if ((!text && !hasAttachments && !hasInlineMentions) || isPrompting)
				return;

			// Remove empty state when first message is sent
			if ($emptyState.parentNode) $emptyState.remove();

			const content = await buildPromptContent(rawText);

			$editor.innerHTML = "";
			getOrCreateEditableTextNode();
			pendingAttachments = [];
			hideComposerHints();
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
						{$composerHints}
						{$attachmentPreview}
						{$editor}
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
		$view
			.querySelector(".acp-input-container")
			?.addEventListener("click", (event) => {
				if (
					event.target instanceof HTMLElement &&
					(event.target.closest(".acp-input-toolbar") ||
						event.target.closest(".acp-composer-hints") ||
						event.target.closest(".acp-attachment-preview") ||
						event.target.closest(".acp-inline-mention-token"))
				) {
					return;
				}
				const selectionState = getComposerSelection();
				if (selectionState) return;
				const textNode = getOrCreateEditableTextNode();
				focusComposerAtNode(textNode, textNode.textContent.length);
			});

		$view.ensureEmptyState = () => {
			if ($messages.children.length > 0) return;
			if ($emptyState.parentNode !== $view) {
				$view.insertBefore($emptyState, $messages);
			}
		};

		$view.resetComposer = () => {
			pendingAttachments = [];
			$editor.innerHTML = "";
			getOrCreateEditableTextNode();
			clearCurrentCwdMentionCache();
			hideComposerHints();
			renderAttachmentPreview();
			updateSendButtonState();
			renderSessionControls();
		};

		$view.refreshComposerControls = () => {
			clearCurrentCwdMentionCache();
			renderSessionControls();
			void refreshComposerHints();
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

	function getUserMessageSnapshots(session) {
		if (!session?.messages?.length) return [];
		return session.messages
			.filter((message) => message.role === "user")
			.map((message, index) => {
				const hasInlineResource = Array.isArray(message.content)
					? message.content.some((block) => {
							return (
								block?.type === "resource_link" || block?.type === "resource"
							);
						})
					: false;
				if (!hasInlineResource) return null;
				return {
					index,
					content: JSON.parse(JSON.stringify(message.content || [])),
				};
			})
			.filter(Boolean);
	}

	function hasPersistablePrompt(session) {
		if (!session?.messages?.length) return false;
		return session.messages.some((message) => {
			if (message.role !== "user" || !Array.isArray(message.content))
				return false;
			return message.content.some((block) => {
				if (!block || typeof block !== "object") return false;
				if (block.type === "text") {
					return Boolean(String(block.text || "").trim());
				}
				return true;
			});
		});
	}

	function saveCurrentSessionHistory() {
		const session = client.session;
		if (!session || !currentSessionUrl) return;
		if (!hasPersistablePrompt(session)) {
			acpHistory.remove({
				sessionId: session.sessionId,
				url: currentSessionUrl,
			});
			return;
		}

		acpHistory.save({
			sessionId: session.sessionId,
			url: currentSessionUrl,
			cwd: session.cwd || $form.getValues().cwd || "",
			agentName: client.agentName,
			title: session.title || "",
			preview: getSessionPreview(),
			turnStops: session.turnStops || [],
			userMessageSnapshots: getUserMessageSnapshots(session),
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

	function restorePersistedUserMessages(historyEntry) {
		const session = client.session;
		if (!session || !Array.isArray(historyEntry?.userMessageSnapshots)) return;
		const userMessages = session.messages.filter((message) => {
			return message.role === "user";
		});
		historyEntry.userMessageSnapshots.forEach((snapshot) => {
			const targetMessage = userMessages[snapshot?.index];
			if (!targetMessage || !Array.isArray(snapshot?.content)) return;
			targetMessage.content = JSON.parse(JSON.stringify(snapshot.content));
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
		const cwd = normalizeSessionCwd(
			entry.cwd || $form.getValues().cwd || "/home",
		);
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

			try {
				await client.loadSession(entry.sessionId, cwd);
			} catch (loadErr) {
				if (!ACPClient.isAuthRequiredError(loadErr)) throw loadErr;
				await handleAuthentication();
				await client.loadSession(entry.sessionId, cwd);
			}
			client.session?.finishAgentTurn();
			currentSessionUrl = entry.url;
			setChatAgentName(entry.agentName || client.agentName);
			restorePersistedTurnStops(entry);
			restorePersistedUserMessages(entry);
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
		$chatView.refreshComposerControls?.();
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
