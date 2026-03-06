import type {
	AvailableCommand,
	ContentBlock,
	RequestPermissionRequest as PermissionRequest,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
	ChatMessage,
	Plan,
	PlanEntry,
	StopReason,
	TimelineEntry,
	ToolCall,
	TurnStop,
} from "./models";
import { StopReason as StopReasons, ToolCallStatus } from "./models";

const STOP_REASON_VALUES = new Set<StopReason>(
	Object.values(StopReasons) as StopReason[],
);

type SessionEventType =
	| "message_update"
	| "timeline_update"
	| "tool_call"
	| "tool_call_update"
	| "available_commands"
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
	readonly turnStops: TurnStop[] = [];
	availableCommands: AvailableCommand[] = [];
	plan: Plan | null = null;
	title: string | null = null;
	updatedAt: string | null = null;

	private agentTextBuffer = "";
	private thoughtTextBuffer = "";
	private userTextBuffer = "";
	private currentAgentMessageId: string | null = null;
	private currentThoughtMessageId: string | null = null;
	private currentUserMessageId: string | null = null;
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
		this.closeCurrentThoughtMessage();
		this.closeCurrentUserMessage();

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
			case "agent_thought_chunk":
				this.handleMessageChunk("thought", update.content);
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
			case "available_commands_update":
				this.handleAvailableCommandsUpdate(update.availableCommands);
				break;
			case "session_info_update":
				this.handleSessionInfoUpdate(update);
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

	finishAgentTurn(stopReason?: StopReason | null): void {
		this.closeCurrentAgentMessage();
		this.closeCurrentThoughtMessage();
		this.closeCurrentUserMessage();
		this.currentPlanEntryId = null;
		const normalizedStopReason = this.normalizeStopReason(stopReason);
		if (this.shouldPersistStopReason(normalizedStopReason)) {
			this.appendTurnStop(normalizedStopReason);
		}
		this.emit("session_end", null);
	}

	getToolCall(toolCallId: string): ToolCall | undefined {
		return this.toolCalls.get(toolCallId);
	}

	setPersistedTurnStops(turnStops: TurnStop[]): void {
		for (let index = this.timeline.length - 1; index >= 0; index--) {
			if (this.timeline[index]?.type === "turn_stop") {
				this.timeline.splice(index, 1);
			}
		}
		this.turnStops.length = 0;

		const normalizedStops = Array.isArray(turnStops)
			? turnStops
					.map((entry) => {
						const stopReason = this.normalizeStopReason(entry?.stopReason);
						if (!this.shouldPersistStopReason(stopReason)) return null;
						const timestamp = Number.isFinite(entry?.timestamp)
							? Number(entry.timestamp)
							: Date.now();
						return { stopReason, timestamp };
					})
					.filter((entry): entry is TurnStop => Boolean(entry))
			: [];

		normalizedStops.forEach((entry) => {
			this.appendTurnStop(entry.stopReason, entry.timestamp);
		});
	}

	private handleMessageChunk(
		role: ChatMessage["role"],
		content: ContentBlock,
	): void {
		let message: ChatMessage;
		if (role === "agent") {
			this.closeCurrentThoughtMessage();
			this.closeCurrentUserMessage();
			message = this.getOrCreateCurrentAgentMessage();
		} else if (role === "thought") {
			this.closeCurrentAgentMessage();
			this.closeCurrentUserMessage();
			message = this.getOrCreateCurrentThoughtMessage();
		} else {
			this.closeCurrentAgentMessage();
			this.closeCurrentThoughtMessage();
			message = this.getOrCreateCurrentUserMessage();
		}
		if (!message) return;

		if (role === "agent" || role === "thought") {
			message.streaming = true;
		}

		if (content.type === "text") {
			const lastBlock = message.content[message.content.length - 1];
			if (lastBlock && lastBlock.type === "text") {
				lastBlock.text += content.text;
			} else {
				message.content.push({
					type: "text",
					text: content.text,
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
		this.closeCurrentThoughtMessage();
		this.closeCurrentUserMessage();

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
		this.closeCurrentThoughtMessage();
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

	private handleAvailableCommandsUpdate(
		availableCommands: AvailableCommand[] | null | undefined,
	): void {
		this.availableCommands = Array.isArray(availableCommands)
			? [...availableCommands]
			: [];
		this.emit("available_commands", this.availableCommands);
	}

	private handleSessionInfoUpdate(update: {
		title?: string | null;
		updatedAt?: string | null;
	}): void {
		if ("title" in update) {
			this.title = update.title ?? null;
		}
		if ("updatedAt" in update) {
			this.updatedAt = update.updatedAt ?? null;
		}
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

	private appendTurnStop(
		stopReason: StopReason,
		timestamp: number = Date.now(),
	): void {
		const turnStop: TurnStop = {
			stopReason,
			timestamp,
		};
		this.turnStops.push(turnStop);
		this.pushTimelineEntry({
			entryId: this.nextTimelineId(),
			type: "turn_stop",
			turnStop,
		});
	}

	private normalizeStopReason(value: unknown): StopReason | null {
		if (typeof value !== "string") return null;
		if (!STOP_REASON_VALUES.has(value as StopReason)) return null;
		return value as StopReason;
	}

	private shouldPersistStopReason(
		stopReason: StopReason | null,
	): stopReason is StopReason {
		if (!stopReason) return false;
		return stopReason !== StopReasons.END_TURN;
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
		if (role === "thought") {
			this.currentThoughtMessageId = message.id;
			this.thoughtTextBuffer = "";
		}
		if (role === "user") {
			this.currentUserMessageId = message.id;
			this.userTextBuffer = "";
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

	private getOrCreateCurrentThoughtMessage(): ChatMessage {
		const existing = this.messages.find(
			(message) => message.id === this.currentThoughtMessageId,
		);
		if (existing) return existing;
		return this.createMessage("thought", [], true);
	}

	private getOrCreateCurrentUserMessage(): ChatMessage {
		const existing = this.messages.find(
			(message) => message.id === this.currentUserMessageId,
		);
		if (existing) return existing;
		return this.createMessage("user", [], false);
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

	private closeCurrentThoughtMessage(): void {
		if (!this.currentThoughtMessageId) return;

		const message = this.messages.find(
			(entry) => entry.id === this.currentThoughtMessageId,
		);
		if (message) {
			message.streaming = false;
			this.emit("message_update", message);
		}

		this.currentThoughtMessageId = null;
		this.thoughtTextBuffer = "";
	}

	private closeCurrentUserMessage(): void {
		if (!this.currentUserMessageId) return;
		this.currentUserMessageId = null;
		this.userTextBuffer = "";
	}

	dispose(): void {
		this.listeners.clear();
		this.pendingPermissions.length = 0;
		this.availableCommands = [];
		this.currentAgentMessageId = null;
		this.currentThoughtMessageId = null;
		this.currentUserMessageId = null;
		this.agentTextBuffer = "";
		this.thoughtTextBuffer = "";
		this.userTextBuffer = "";
		this.turnStops.length = 0;
	}
}
