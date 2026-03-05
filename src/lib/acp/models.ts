import type {
	Plan as ACPPlan,
	ToolCall as ACPToolCall,
	ContentBlock,
	PlanEntry,
} from "@agentclientprotocol/sdk";

export const ToolCallStatus = {
	PENDING: "pending",
	IN_PROGRESS: "in_progress",
	COMPLETED: "completed",
	FAILED: "failed",
} as const;

export const ToolKind = {
	READ: "read",
	EDIT: "edit",
	DELETE: "delete",
	MOVE: "move",
	SEARCH: "search",
	EXECUTE: "execute",
	THINK: "think",
	FETCH: "fetch",
	SWITCH_MODE: "switch_mode",
	OTHER: "other",
} as const;

export const PlanEntryStatus = {
	PENDING: "pending",
	IN_PROGRESS: "in_progress",
	COMPLETED: "completed",
} as const;

export const ConnectionState = {
	DISCONNECTED: "disconnected",
	CONNECTING: "connecting",
	CONNECTED: "connected",
	INITIALIZING: "initializing",
	READY: "ready",
	ERROR: "error",
} as const;

export type ToolCallStatus =
	(typeof ToolCallStatus)[keyof typeof ToolCallStatus];
export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];
export type PlanEntryStatus =
	(typeof PlanEntryStatus)[keyof typeof PlanEntryStatus];
export type ConnectionState =
	(typeof ConnectionState)[keyof typeof ConnectionState];

export interface ToolCall extends ACPToolCall {
	timestamp?: number;
}

export interface Plan extends ACPPlan {
	timestamp?: number;
}

export type { PlanEntry };

export interface ChatMessage {
	id: string;
	role: "user" | "agent" | "thought";
	content: ContentBlock[];
	timestamp: number;
	streaming?: boolean;
}

export type TimelineEntry =
	| {
			entryId: string;
			type: "message";
			message: ChatMessage;
	  }
	| {
			entryId: string;
			type: "tool_call";
			toolCall: ToolCall;
	  }
	| {
			entryId: string;
			type: "plan";
			plan: Plan;
	  };
