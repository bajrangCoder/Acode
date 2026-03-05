import fsOperation from "fileSystem";
import toast from "components/toast";
import DOMPurify from "dompurify";
import openFile from "lib/openFile";
import openFolder from "lib/openFolder";
import markdownIt from "markdown-it";
import Url from "utils/Url";

const markdown = markdownIt({
	breaks: true,
	html: false,
	linkify: true,
});

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const LOCAL_FILE_PROTOCOLS = new Set(["file:"]);
const ATTACHMENT_PROTOCOLS = new Set(["file:", "content:"]);
const INLINE_ATTACHMENT_LINK_RE = /\[(?:@)?([^\]]+)\]\(([^)]+)\)/gi;
const INLINE_CONTEXT_RE =
	/<context\b[^>]*\bref=(["'])([^"']+)\1[^>]*>[\s\S]*?<\/context>/gi;
const INLINE_CONTEXT_SELF_CLOSING_RE =
	/<context\b[^>]*\bref=(["'])([^"']+)\1[^>]*\/>/gi;

function getTerminalPaths() {
	const packageName = window.BuildInfo?.packageName || "com.foxdebug.acode";
	const dataDir = `/data/user/0/${packageName}`;
	return {
		dataDir,
		alpineRoot: `${dataDir}/files/alpine`,
		publicDir: `${dataDir}/files/public`,
	};
}

function safeDecode(value = "") {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function renderMarkdown(text = "") {
	return DOMPurify.sanitize(markdown.render(text), {
		FORBID_TAGS: ["script", "style"],
	});
}

function isExternalHref(href = "") {
	return EXTERNAL_PROTOCOLS.has(Url.getProtocol(href));
}

function isLocalFileHref(href = "") {
	return LOCAL_FILE_PROTOCOLS.has(Url.getProtocol(href));
}

function getCursorPosFromHash(hash = "") {
	const match = /^L(\d+)(?:C(\d+))?$/i.exec(hash.replace(/^#/, ""));
	if (!match) return null;

	return {
		row: Number(match[1]),
		column: match[2] ? Math.max(0, Number(match[2]) - 1) : 0,
	};
}

function normalizePathString(value = "") {
	return safeDecode(String(value || "").trim())
		.replace(/^<|>$/g, "")
		.replace(/^["']|["']$/g, "");
}

function convertProotPath(path = "") {
	const normalizedPath = normalizePathString(path);
	if (!normalizedPath) return normalizedPath;

	const { dataDir, alpineRoot } = getTerminalPaths();
	if (isLocalFileHref(normalizedPath)) {
		return normalizedPath;
	}
	if (normalizedPath.startsWith("/public")) {
		return `file://${dataDir}/files${normalizedPath}`;
	}
	if (
		normalizedPath.startsWith("/sdcard") ||
		normalizedPath.startsWith("/storage") ||
		normalizedPath.startsWith("/data")
	) {
		return `file://${normalizedPath}`;
	}
	if (normalizedPath.startsWith("/home/") || normalizedPath === "/home") {
		const suffix = normalizedPath.slice("/home".length);
		return `file://${alpineRoot}/home${suffix}`;
	}
	if (normalizedPath.startsWith("/")) {
		return `file://${alpineRoot}${normalizedPath}`;
	}

	return normalizedPath;
}

function resolveCwd(cwd = "") {
	const normalizedCwd = normalizePathString(cwd);
	if (!normalizedCwd) return "";
	return isLocalFileHref(normalizedCwd)
		? normalizedCwd
		: convertProotPath(normalizedCwd);
}

function buildLocalCandidates(target = "", cwd = "") {
	const normalizedTarget = normalizePathString(target);
	const normalizedCwd = resolveCwd(cwd);
	if (!normalizedTarget) return [];

	const candidates = [];
	const addCandidate = (value) => {
		const normalized = normalizePathString(value);
		if (!normalized || candidates.includes(normalized)) return;
		candidates.push(normalized);
	};

	if (Url.getProtocol(normalizedTarget)) {
		addCandidate(normalizedTarget);
		return candidates;
	}

	if (
		normalizedTarget.startsWith("/") ||
		normalizedTarget.startsWith("~/") ||
		normalizedTarget === "~"
	) {
		const homePath =
			normalizedTarget === "~"
				? "/home"
				: normalizedTarget.replace(/^~(?=\/)/, "/home");
		addCandidate(convertProotPath(homePath));
		addCandidate(homePath);
		return candidates;
	}

	if (normalizedCwd) {
		addCandidate(Url.join(normalizedCwd, normalizedTarget));
	}

	addCandidate(convertProotPath(normalizedTarget));
	addCandidate(normalizedTarget);

	return candidates;
}

function resolveLocalHref(href = "", cwd = "") {
	const [rawTarget, rawHash = ""] = href.split("#");
	const target = normalizePathString(rawTarget);
	if (!target) return null;

	return {
		candidates: buildLocalCandidates(target, cwd),
		cursorPos: getCursorPosFromHash(rawHash),
	};
}

function isAttachmentLikeHref(href = "") {
	const normalizedHref = normalizePathString(href);
	if (!normalizedHref) return false;
	const protocol = Url.getProtocol(normalizedHref);
	if (!protocol) {
		return (
			normalizedHref.startsWith("/") ||
			normalizedHref.startsWith("~/") ||
			normalizedHref === "~"
		);
	}
	return ATTACHMENT_PROTOCOLS.has(protocol);
}

function toResourceChipData(block) {
	if (block.type === "resource_link") {
		const uri = block.uri || "";
		const label = sanitizeInlineLabel(block.name || block.title || "", uri);
		return {
			href: uri || "#",
			label: label || uri || "Attachment",
		};
	}

	if (block.type === "resource") {
		const uri = block.resource?.uri || "";
		const label = sanitizeInlineLabel("", uri);
		return {
			href: uri || "#",
			label: label || uri || "Attachment",
		};
	}

	return null;
}

function sanitizeInlineLabel(label = "", uri = "") {
	const normalized = String(label || "")
		.trim()
		.replace(/^@+/, "");
	if (normalized) return normalized;
	return Url.basename(uri) || uri || "Attachment";
}

function extractInlineContextReferences(text = "") {
	if (!text) return { text: "", resources: [] };
	INLINE_ATTACHMENT_LINK_RE.lastIndex = 0;
	const hasInlineAttachmentLinks = INLINE_ATTACHMENT_LINK_RE.test(text);
	INLINE_ATTACHMENT_LINK_RE.lastIndex = 0;
	INLINE_CONTEXT_RE.lastIndex = 0;
	const hasInlineContexts = INLINE_CONTEXT_RE.test(text);
	INLINE_CONTEXT_RE.lastIndex = 0;
	INLINE_CONTEXT_SELF_CLOSING_RE.lastIndex = 0;
	const hasSelfClosingContexts = INLINE_CONTEXT_SELF_CLOSING_RE.test(text);
	INLINE_CONTEXT_SELF_CLOSING_RE.lastIndex = 0;
	if (
		!hasInlineAttachmentLinks &&
		!hasInlineContexts &&
		!hasSelfClosingContexts
	) {
		return { text, resources: [] };
	}

	const resources = [];
	let cleaned = text;

	cleaned = cleaned.replace(INLINE_ATTACHMENT_LINK_RE, (match, label, uri) => {
		if (!isAttachmentLikeHref(uri)) return match;
		if (uri) {
			resources.push({
				type: "resource_link",
				name: sanitizeInlineLabel(label, uri),
				uri: String(uri),
			});
		}
		return "";
	});

	cleaned = cleaned.replace(INLINE_CONTEXT_RE, (_match, _quote, uri) => {
		if (uri) {
			resources.push({
				type: "resource_link",
				name: Url.basename(uri) || "Attachment",
				uri: String(uri),
			});
		}
		return "";
	});

	cleaned = cleaned.replace(
		INLINE_CONTEXT_SELF_CLOSING_RE,
		(_match, _quote, uri) => {
			if (uri) {
				resources.push({
					type: "resource_link",
					name: Url.basename(uri) || "Attachment",
					uri: String(uri),
				});
			}
			return "";
		},
	);

	return {
		text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
		resources,
	};
}

async function resolveExistingPath(candidates = []) {
	for (const candidate of candidates) {
		try {
			const stat = await fsOperation(candidate).stat();
			return { url: candidate, stat };
		} catch {
			// Keep trying fallbacks until one resolves.
		}
	}

	return null;
}

function ThoughtMessage({
	message: initMessage,
	isResponding: initResponding,
}) {
	let message = initMessage;
	let messageResponding = initResponding;
	let isExpanded = false;

	const $icon = <i className="icon react acp-thinking-icon"></i>;
	const $title = <span className="acp-thinking-title"></span>;
	const $chevron = <i className="icon expand_more acp-thinking-chevron"></i>;
	const $body = <div className="acp-thinking-body"></div>;

	const $header = (
		<div
			className="acp-thinking-header"
			onclick={() => {
				isExpanded = !isExpanded;
				$body.classList.toggle("expanded", isExpanded);
				$chevron.classList.toggle("expanded", isExpanded);
			}}
		>
			<div className="acp-thinking-header-left">
				{$icon}
				{$title}
			</div>
			{$chevron}
		</div>
	);

	function renderThinking() {
		$body.innerHTML = "";
		const textBlocks = (message.content || []).filter((b) => b.type === "text");
		const text = textBlocks.map((b) => b.text).join("\n");
		if (text) {
			const $markdown = <div className="acp-markdown-block md"></div>;
			$markdown.innerHTML = renderMarkdown(text);
			$body.append($markdown);
		}

		const isActive = Boolean(messageResponding);
		$title.textContent = isActive ? "Thinking…" : "Thought Process";
		$icon.classList.toggle("active", isActive);
		$el.classList.toggle("streaming", isActive);
	}

	renderThinking();

	const $el = (
		<div className="acp-message thought">
			<div className="acp-thinking-block">
				{$header}
				{$body}
			</div>
		</div>
	);

	const timestamp = new Date(message.timestamp);
	$el.title = Number.isNaN(timestamp.getTime())
		? ""
		: timestamp.toLocaleString();

	$el.update = (msg) => {
		message = msg.message || msg;
		if ("isResponding" in msg) messageResponding = Boolean(msg.isResponding);
		renderThinking();
		const ts = new Date(message.timestamp);
		$el.title = Number.isNaN(ts.getTime()) ? "" : ts.toLocaleString();
	};

	return $el;
}

export default function ChatMessage({
	message,
	cwd = "",
	isResponding = false,
}) {
	if (message.role === "thought") {
		return ThoughtMessage({ message, isResponding });
	}

	let messageCwd = cwd;
	let messageResponding = isResponding;

	const $content = <div className="acp-message-content"></div>;
	const $meta = <div className="acp-message-meta"></div>;
	const $role = <div className="acp-message-role"></div>;

	$content.onclick = async (event) => {
		const target =
			event.target?.nodeType === Node.TEXT_NODE
				? event.target.parentElement
				: event.target;
		const $link = target?.closest?.("a[href]");
		if (!$link || !$content.contains($link)) return;

		const href = ($link.getAttribute("href") || "").trim();
		if (!href || href === "#") return;

		event.preventDefault();
		event.stopPropagation();

		try {
			if (isExternalHref(href)) {
				system.openInBrowser(href);
				return;
			}

			const resolved = resolveLocalHref(href, messageCwd);
			const match = await resolveExistingPath(resolved?.candidates || []);
			if (!match?.url || !match.stat) {
				await openFile(href, {
					render: true,
					cursorPos: resolved?.cursorPos || undefined,
				});
				return;
			}

			if (match.stat.isDirectory) {
				await openFolder(match.url, {
					name: match.stat.name || Url.basename(match.url) || "Folder",
					saveState: true,
					listFiles: true,
				});
				return;
			}

			await openFile(match.url, {
				render: true,
				cursorPos: resolved.cursorPos || undefined,
			});
		} catch (error) {
			console.error("[ACP] Failed to open linked resource:", error);
			toast(error?.message || "Failed to open linked resource");
		}
	};

	function appendTextBlock(text) {
		if (message.role === "agent") {
			const $markdown = <div className="acp-markdown-block md"></div>;
			$markdown.innerHTML = renderMarkdown(text);
			$content.append($markdown);
			return;
		}

		$content.append(<div className="acp-message-text">{text}</div>);
	}

	function appendResourceChips(resourceLinks = []) {
		if (!resourceLinks.length) return;

		const seen = new Set();
		const $attachmentRow = <div className="acp-message-attachments"></div>;
		resourceLinks.forEach((block) => {
			const resource = toResourceChipData(block);
			if (!resource) return;
			const key = resource.href || resource.label;
			if (!key || seen.has(key)) return;
			seen.add(key);

			$attachmentRow.append(
				<a
					className="acp-resource-chip"
					href={resource.href}
					title={resource.href}
				>
					<i className="icon attach_file"></i>
					<span className="acp-resource-chip-meta">
						<span className="acp-resource-chip-title">{resource.label}</span>
					</span>
				</a>,
			);
		});

		$content.append($attachmentRow);
	}

	function renderContent() {
		$content.innerHTML = "";
		const extractedTextResources = [];
		const displayBlocks = message.content
			.map((block) => {
				if (message.role !== "user" || block.type !== "text") return block;
				const extracted = extractInlineContextReferences(block.text);
				if (extracted.resources.length) {
					extractedTextResources.push(...extracted.resources);
				}
				if (!extracted.text) return null;
				return { ...block, text: extracted.text };
			})
			.filter(Boolean);

		const resourceLinks = [
			...message.content.filter((block) => {
				return block.type === "resource_link" || block.type === "resource";
			}),
			...extractedTextResources,
		].filter((block) => {
			return block.type === "resource_link" || block.type === "resource";
		});
		appendResourceChips(resourceLinks);

		displayBlocks.forEach((block) => {
			if (block.type === "text") {
				appendTextBlock(block.text);
			} else if (block.type === "resource_link" || block.type === "resource") {
				// Resource links are rendered as chips above message text.
			} else if (block.type === "image" && block.data) {
				$content.append(
					<img
						className="acp-inline-image"
						src={`data:${block.mimeType};base64,${block.data}`}
					/>,
				);
			}
		});
	}

	function renderMeta() {
		$meta.innerHTML = "";
		if (messageResponding && message.role === "agent") {
			$meta.append(
				<span className="acp-streaming-indicator">
					<span className="acp-streaming-dot"></span>
					<span className="acp-streaming-dot"></span>
					<span className="acp-streaming-dot"></span>
					<span className="acp-streaming-label">Responding</span>
				</span>,
			);
		}
		$role.textContent = message.role === "user" ? "You" : "Agent";
		$meta.hidden = $meta.childElementCount === 0;
		const timestamp = new Date(message.timestamp);
		$el.title = Number.isNaN(timestamp.getTime())
			? ""
			: timestamp.toLocaleString();
		$el.classList.toggle("streaming", Boolean(messageResponding));
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
		if (msg.cwd) messageCwd = msg.cwd;
		if ("isResponding" in msg) messageResponding = Boolean(msg.isResponding);
		renderContent();
		renderMeta();
	};

	return $el;
}
