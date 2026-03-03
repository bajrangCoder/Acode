import type {
	ContentBlock,
	RequestPermissionRequest as PermissionRequest,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
	ChatMessage,
	Plan,
	PlanEntry,
	TimelineEntry,
	ToolCall,
} from "./models";
import { ToolCallStatus } from "./models";

type SessionEventType =
	| "message_update"
	| "timeline_update"
	| "tool_call"
	| "tool_call_update"
	| "plan"
	| "permission_request"
	| "session_end";

type SessionEventHandler = (data: unknown) => void;

export class ACPSession {
	readonly sessionId: string;
	readonly cwd: string;
	readonly messages: ChatMessage[] = [];
	readonly timeline: TimelineEntry[] = [];
	readonly toolCalls: Map<string, ToolCall> = new Map();
	plan: Plan | null = null;

	private agentTextBuffer = "";
	private currentAgentMessageId: string | null = null;
	private currentPlanEntryId: string | null = null;
	private listeners = new Map<SessionEventType, Set<SessionEventHandler>>();
	private pendingPermissions: PermissionRequest[] = [];
	private messageIdCounter = 0;
	private timelineIdCounter = 0;

	constructor(sessionId: string, cwd: string) {
		this.sessionId = sessionId;
		this.cwd = cwd;
	}

	on(event: SessionEventType, handler: SessionEventHandler): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)!.add(handler);
	}

	off(event: SessionEventType, handler: SessionEventHandler): void {
		this.listeners.get(event)?.delete(handler);
	}

	private emit(event: SessionEventType, data: unknown): void {
		this.listeners.get(event)?.forEach((handler) => {
			try {
				handler(data);
			} catch (e) {
				console.error(`[ACP Session] Event handler error for '${event}':`, e);
			}
		});
	}

	addUserMessage(content: ContentBlock[]): ChatMessage {
		this.closeCurrentAgentMessage();

		const message: ChatMessage = {
			id: this.nextMessageId(),
			role: "user",
			content,
			timestamp: Date.now(),
			streaming: false,
		};
		this.messages.push(message);
		this.pushTimelineEntry({
			entryId: this.nextTimelineId(),
			type: "message",
			message,
		});
		this.emit("message_update", message);
		return message;
	}

	handleSessionUpdate(update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case "user_message_chunk":
				this.handleMessageChunk("user", update.content);
				break;
			case "agent_message_chunk":
				this.handleMessageChunk("agent", update.content);
				break;
			case "tool_call":
				this.handleToolCall(update);
				break;
			case "tool_call_update":
				this.handleToolCallUpdate(update);
				break;
			case "plan":
				this.handlePlan(update.entries);
				break;
		}
	}

	handlePermissionRequest(request: PermissionRequest): void {
		this.pendingPermissions.push(request);
		this.emit("permission_request", request);
	}

	getNextPermissionRequest(): PermissionRequest | undefined {
		return this.pendingPermissions.shift();
	}

	finishAgentTurn(): void {
		this.closeCurrentAgentMessage();
		this.currentPlanEntryId = null;
		this.emit("session_end", null);
	}

	getToolCall(toolCallId: string): ToolCall | undefined {
		return this.toolCalls.get(toolCallId);
	}

	private handleMessageChunk(
		role: ChatMessage["role"],
		content: ContentBlock,
	): void {
		const message =
			role === "agent"
				? this.getOrCreateCurrentAgentMessage()
				: this.createMessage(role, [], false);
		if (!message) return;

		if (role === "agent") {
			message.streaming = true;
		}

		if (content.type === "text") {
			if (role === "agent") {
				this.agentTextBuffer += content.text;
			}
			const existingText = message.content.find((c) => c.type === "text");
			if (existingText && existingText.type === "text") {
				existingText.text =
					role === "agent"
						? this.agentTextBuffer
						: existingText.text + content.text;
			} else {
				message.content.push({
					type: "text",
					text: role === "agent" ? this.agentTextBuffer : content.text,
				});
			}
		} else {
			message.content.push(content);
		}

		this.emit("message_update", message);
	}

	private handleToolCall(
		update: SessionUpdate & { sessionUpdate: "tool_call" },
	): void {
		this.closeCurrentAgentMessage();

		const toolCall: ToolCall = {
			toolCallId: update.toolCallId,
			title: update.title,
			kind: update.kind,
			status: update.status,
			content: update.content,
			locations: update.locations,
			rawInput: update.rawInput,
			rawOutput: update.rawOutput,
			timestamp: Date.now(),
		};

		this.toolCalls.set(toolCall.toolCallId, toolCall);
		this.pushTimelineEntry({
			entryId: this.nextTimelineId(),
			type: "tool_call",
			toolCall,
		});

		this.emit("tool_call", toolCall);
	}

	private handleToolCallUpdate(
		update: SessionUpdate & { sessionUpdate: "tool_call_update" },
	): void {
		const existing: ToolCall = this.toolCalls.get(update.toolCallId) || {
			toolCallId: update.toolCallId,
			title: update.title || "Tool call",
			status: update.status || ToolCallStatus.PENDING,
			timestamp: Date.now(),
		};

		if (!this.toolCalls.has(update.toolCallId)) {
			this.toolCalls.set(update.toolCallId, existing);
			this.pushTimelineEntry({
				entryId: this.nextTimelineId(),
				type: "tool_call",
				toolCall: existing,
			});
		}

		if (update.title != null) existing.title = update.title;
		if (update.kind != null) existing.kind = update.kind;
		if (update.status != null) existing.status = update.status;
		if ("content" in update) {
			existing.content = update.content || [];
		}
		if ("locations" in update) {
			existing.locations = update.locations || [];
		}
		if ("rawInput" in update) existing.rawInput = update.rawInput;
		if ("rawOutput" in update) existing.rawOutput = update.rawOutput;

		this.emit("tool_call_update", existing);
	}

	private handlePlan(entries: PlanEntry[]): void {
		this.plan = {
			entries,
			timestamp: this.plan?.timestamp || Date.now(),
		};

		if (!this.currentPlanEntryId) {
			this.currentPlanEntryId = this.nextTimelineId();
			this.pushTimelineEntry({
				entryId: this.currentPlanEntryId,
				type: "plan",
				plan: this.plan,
			});
		} else {
			const existingEntry = this.timeline.find(
				(entry) =>
					entry.type === "plan" && entry.entryId === this.currentPlanEntryId,
			);
			if (existingEntry && existingEntry.type === "plan") {
				existingEntry.plan = this.plan;
			}
		}

		this.emit("plan", this.plan);
	}

	private nextMessageId(): string {
		return `msg_${++this.messageIdCounter}_${Date.now()}`;
	}

	private nextTimelineId(): string {
		return `entry_${++this.timelineIdCounter}_${Date.now()}`;
	}

	private pushTimelineEntry(entry: TimelineEntry): void {
		this.timeline.push(entry);
		this.emit("timeline_update", entry);
	}

	private createMessage(
		role: ChatMessage["role"],
		content: ContentBlock[] = [],
		streaming = false,
	): ChatMessage {
		const message: ChatMessage = {
			id: this.nextMessageId(),
			role,
			content,
			timestamp: Date.now(),
			streaming,
		};
		this.messages.push(message);
		this.pushTimelineEntry({
			entryId: this.nextTimelineId(),
			type: "message",
			message,
		});
		if (role === "agent") {
			this.currentAgentMessageId = message.id;
			this.agentTextBuffer = "";
		}
		return message;
	}

	private getOrCreateCurrentAgentMessage(): ChatMessage {
		const existing = this.messages.find(
			(message) => message.id === this.currentAgentMessageId,
		);
		if (existing) return existing;
		return this.createMessage("agent", [], true);
	}

	private closeCurrentAgentMessage(): void {
		if (!this.currentAgentMessageId) return;

		const message = this.messages.find(
			(entry) => entry.id === this.currentAgentMessageId,
		);
		if (message) {
			message.streaming = false;
			this.emit("message_update", message);
		}

		this.currentAgentMessageId = null;
		this.agentTextBuffer = "";
	}

	dispose(): void {
		this.listeners.clear();
		this.pendingPermissions.length = 0;
	}
}
