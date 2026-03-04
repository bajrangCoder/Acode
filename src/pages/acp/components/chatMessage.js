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

export default function ChatMessage({
	message,
	cwd = "",
	isResponding = false,
}) {
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
				throw new Error(`Unable to resolve path: ${href}`);
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

	function renderContent() {
		$content.innerHTML = "";
		message.content.forEach((block) => {
			if (block.type === "text") {
				appendTextBlock(block.text);
			} else if (block.type === "resource_link") {
				$content.append(
					<a className="acp-resource-link" href={block.uri || "#"}>
						{block.name || block.uri}
					</a>,
				);
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
		if (messageResponding) {
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
