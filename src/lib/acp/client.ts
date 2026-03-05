import {
	type Client as ACPProtocolClient,
	type AgentCapabilities,
	type ClientCapabilities,
	ClientSideConnection,
	type ContentBlock,
	type Implementation,
	type InitializeResponse as InitializeResult,
	type ListSessionsResponse as ListSessionsResult,
	type LoadSessionResponse as LoadSessionResult,
	type McpServer,
	type NewSessionResponse as NewSessionResult,
	type RequestPermissionRequest as PermissionRequest,
	type RequestPermissionResponse as PermissionResponse,
	PROTOCOL_VERSION,
	type PromptResponse as PromptResult,
	RequestError,
	type RequestId,
	type SessionConfigOption,
	type SessionModelState,
	type SessionModeState,
	type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { ConnectionState } from "./models";
import { ACPSession } from "./session";
import type { TransportConfig } from "./transport";
import { createTransport } from "./transport";

const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
	fs: {},
	terminal: false,
};

const DEFAULT_CLIENT_INFO: Implementation = {
	name: "Acode",
	version: "1.0.0",
};

const ACP_METHODS = {
	FS_READ_TEXT_FILE: "fs/read_text_file",
	FS_WRITE_TEXT_FILE: "fs/write_text_file",
	TERMINAL_CREATE: "terminal/create",
	TERMINAL_OUTPUT: "terminal/output",
	TERMINAL_RELEASE: "terminal/release",
	TERMINAL_WAIT_FOR_EXIT: "terminal/wait_for_exit",
	TERMINAL_KILL: "terminal/kill",
} as const;

type ClientEventType =
	| "state_change"
	| "session_update"
	| "session_controls_update"
	| "error"
	| "permission_request";

type ClientEventHandler = (data: unknown) => void;

type PendingPermissionRequest = {
	resolve: (response: PermissionResponse) => void;
};

export interface StartSessionOptions {
	url: string;
	cwd?: string;
	mcpServers?: McpServer[];
	clientCapabilities?: ClientCapabilities;
	clientInfo?: Implementation;
}

export class ACPClient {
	private transportHandle: ReturnType<typeof createTransport> | null = null;
	private connection: ClientSideConnection | null = null;
	private listeners = new Map<ClientEventType, Set<ClientEventHandler>>();
	private requestHandlers = new Map<
		string,
		(params: any) => Promise<unknown> | unknown
	>();
	private pendingPermissionRequests = new Map<
		RequestId,
		PendingPermissionRequest
	>();
	private nextPermissionRequestId = 1;

	private _state: ConnectionState = ConnectionState.DISCONNECTED;
	private _agentCapabilities: AgentCapabilities | null = null;
	private _agentInfo: Implementation | null = null;
	private _session: ACPSession | null = null;
	private _sessionModes: SessionModeState | null = null;
	private _sessionModels: SessionModelState | null = null;
	private _sessionConfigOptions: SessionConfigOption[] = [];

	get state(): ConnectionState {
		return this._state;
	}

	get agentCapabilities(): AgentCapabilities | null {
		return this._agentCapabilities;
	}

	get agentInfo(): Implementation | null {
		return this._agentInfo;
	}

	get session(): ACPSession | null {
		return this._session;
	}

	get sessionModes(): SessionModeState | null {
		return this._sessionModes;
	}

	get sessionModels(): SessionModelState | null {
		return this._sessionModels;
	}

	get sessionConfigOptions(): SessionConfigOption[] {
		return this._sessionConfigOptions;
	}

	get agentName(): string {
		return this._agentInfo?.title || this._agentInfo?.name || "Agent";
	}

	on(event: ClientEventType, handler: ClientEventHandler): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)?.add(handler);
	}

	off(event: ClientEventType, handler: ClientEventHandler): void {
		this.listeners.get(event)?.delete(handler);
	}

	private emit(event: ClientEventType, data: unknown): void {
		this.listeners.get(event)?.forEach((handler) => {
			try {
				handler(data);
			} catch (error) {
				console.error(
					`[ACP Client] Event handler error for '${event}':`,
					error,
				);
			}
		});
	}

	private setState(newState: ConnectionState): void {
		const oldState = this._state;
		this._state = newState;
		this.emit("state_change", { oldState, newState });
	}

	registerRequestHandler(
		method: string,
		handler: (params: any) => Promise<unknown> | unknown,
	): void {
		this.requestHandlers.set(method, handler);
	}

	async connect(config: TransportConfig): Promise<void> {
		if (
			this._state !== ConnectionState.DISCONNECTED &&
			this._state !== ConnectionState.ERROR
		) {
			throw new Error("Client is already connected or connecting");
		}

		this.setState(ConnectionState.CONNECTING);

		try {
			this.transportHandle = createTransport(config);

			this.transportHandle.onError = (error: Error) => {
				console.error("[ACP Client] Transport error:", error);
				this.emit("error", error);
			};

			this.transportHandle.onClose = (reason?: string) => {
				console.info("[ACP Client] Transport closed:", reason);
				this.handleTransportClosed(reason);
			};

			await this.transportHandle.ready;

			this.connection = new ClientSideConnection(
				() => this.createClientAdapter(),
				this.transportHandle.stream,
			);

			void this.connection.closed.then(() => {
				if (this.transportHandle?.connected) return;
				this.handleTransportClosed();
			});

			this.setState(ConnectionState.CONNECTED);
		} catch (error) {
			this.setState(ConnectionState.ERROR);
			this.transportHandle?.dispose();
			this.transportHandle = null;
			this.connection = null;
			throw error;
		}
	}

	async initialize(
		clientCapabilities: ClientCapabilities = DEFAULT_CLIENT_CAPABILITIES,
		clientInfo: Implementation = DEFAULT_CLIENT_INFO,
	): Promise<InitializeResult> {
		if (this._state !== ConnectionState.CONNECTED) {
			throw new Error("Must be connected before initializing");
		}

		const connection = this.getConnection();
		this.setState(ConnectionState.INITIALIZING);

		try {
			const result = await this.runWhileConnected(
				connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: this.buildClientCapabilities(clientCapabilities),
					clientInfo,
				}),
			);

			this._agentCapabilities = result.agentCapabilities ?? null;
			this._agentInfo = result.agentInfo ?? null;
			this.setState(ConnectionState.READY);
			return result;
		} catch (error) {
			this.setState(ConnectionState.ERROR);
			throw error;
		}
	}

	async newSession(
		cwd?: string,
		mcpServers?: McpServer[],
	): Promise<ACPSession> {
		this.ensureReady();

		const connection = this.getConnection();
		const params: Record<string, unknown> = {
			mcpServers: mcpServers ?? [],
		};

		if (cwd) {
			params.cwd = cwd;
		}

		const result = (await this.runWhileConnected(
			connection.newSession(params as never),
		)) as NewSessionResult;

		this.setSessionConfigurationState(result);
		this._session?.dispose();
		this._session = new ACPSession(result.sessionId, cwd || "");
		return this._session;
	}

	async loadSession(
		sessionId: string,
		cwd: string,
		mcpServers?: McpServer[],
	): Promise<ACPSession> {
		this.ensureReady();

		if (!this._agentCapabilities?.loadSession) {
			throw new Error("This agent does not support session/load");
		}

		const connection = this.getConnection();
		const session = new ACPSession(sessionId, cwd);

		this._session?.dispose();
		this._session = session;

		try {
			const result = (await this.runWhileConnected(
				connection.loadSession({
					sessionId,
					cwd,
					mcpServers: mcpServers ?? [],
				}),
			)) as LoadSessionResult;
			this.setSessionConfigurationState(result);
			return session;
		} catch (error) {
			if (this._session === session) {
				session.dispose();
				this._session = null;
				this.clearSessionConfigurationState(true);
			}
			throw error;
		}
	}

	async unstableListSessions(cwd?: string): Promise<ListSessionsResult> {
		this.ensureReady();

		if (!this._agentCapabilities?.sessionCapabilities?.list) {
			throw new Error("This agent does not support session/list");
		}

		const connection = this.getConnection();

		return (await this.runWhileConnected(
			connection.unstable_listSessions({
				cwd: cwd || undefined,
			}),
		)) as ListSessionsResult;
	}

	async startSession({
		url,
		cwd,
		mcpServers = [],
		clientCapabilities = DEFAULT_CLIENT_CAPABILITIES,
		clientInfo = DEFAULT_CLIENT_INFO,
	}: StartSessionOptions): Promise<ACPSession> {
		try {
			await this.connect({ type: "websocket", url });
			await this.initialize(clientCapabilities, clientInfo);
			return await this.newSession(cwd, mcpServers);
		} catch (error) {
			try {
				await this.disconnect();
			} catch {
				/* ignore */
			}
			throw error;
		}
	}

	async prompt(content: ContentBlock[]): Promise<PromptResult> {
		this.ensureReady();
		const session = this._session;
		if (!session) {
			throw new Error("No active session. Call newSession() first.");
		}

		const connection = this.getConnection();
		session.addUserMessage(content);

		try {
			const result = await this.runWhileConnected(
				connection.prompt({
					sessionId: session.sessionId,
					prompt: content,
				}),
			);

			session.finishAgentTurn(result.stopReason);
			return result;
		} catch (error) {
			session.finishAgentTurn();
			throw error;
		}
	}

	async sendTextPrompt(text: string): Promise<PromptResult> {
		return await this.prompt([{ type: "text", text }]);
	}

	async setSessionMode(modeId: string): Promise<void> {
		this.ensureReady();
		const sessionId = this.ensureSessionId();
		const connection = this.getConnection();

		await this.runWhileConnected(
			connection.setSessionMode({
				sessionId,
				modeId,
			}),
		);
		this.updateSessionModeId(modeId);
	}

	async setSessionModel(modelId: string): Promise<void> {
		this.ensureReady();
		const sessionId = this.ensureSessionId();
		const connection = this.getConnection();

		await this.runWhileConnected(
			connection.unstable_setSessionModel({
				sessionId,
				modelId,
			}),
		);
		this.updateSessionModelId(modelId);
	}

	async setSessionConfigOption(configId: string, value: string): Promise<void> {
		this.ensureReady();
		const sessionId = this.ensureSessionId();
		const connection = this.getConnection();

		const result = await this.runWhileConnected(
			connection.setSessionConfigOption({
				sessionId,
				configId,
				value,
			}),
		);

		if (result.configOptions) {
			this.setSessionConfigOptions(result.configOptions);
			return;
		}

		this.updateSessionConfigOptionValue(configId, value);
	}

	cancel(): void {
		if (!this._session || !this.connection) return;

		this.resolveAllPermissionRequests({
			outcome: {
				outcome: "cancelled",
			},
		});

		void this.connection
			.cancel({
				sessionId: this._session.sessionId,
			})
			.catch((error) => {
				this.emit("error", error);
			});
	}

	respondPermission(requestId: RequestId, response: PermissionResponse): void {
		const pending = this.pendingPermissionRequests.get(requestId);
		if (!pending) return;

		this.pendingPermissionRequests.delete(requestId);
		pending.resolve(response);
	}

	async disconnect(): Promise<void> {
		this.resolveAllPermissionRequests({
			outcome: {
				outcome: "cancelled",
			},
		});

		this.disposeSessionState();

		const transportHandle = this.transportHandle;
		this.transportHandle = null;
		this.connection = null;

		transportHandle?.dispose();
		this.setState(ConnectionState.DISCONNECTED);
	}

	private createClientAdapter(): ACPProtocolClient {
		return {
			requestPermission: async (params) => this.handlePermissionRequest(params),
			sessionUpdate: async (params) => this.handleSessionUpdate(params),
			readTextFile: async (params) =>
				this.callRegisteredRequest(ACP_METHODS.FS_READ_TEXT_FILE, params),
			writeTextFile: async (params) =>
				this.callRegisteredRequest(ACP_METHODS.FS_WRITE_TEXT_FILE, params),
			createTerminal: async (params) =>
				this.callRegisteredRequest(ACP_METHODS.TERMINAL_CREATE, params),
			terminalOutput: async (params) =>
				this.callRegisteredRequest(ACP_METHODS.TERMINAL_OUTPUT, params),
			releaseTerminal: async (params) =>
				this.callRegisteredRequest(ACP_METHODS.TERMINAL_RELEASE, params),
			waitForTerminalExit: async (params) =>
				this.callRegisteredRequest(ACP_METHODS.TERMINAL_WAIT_FOR_EXIT, params),
			killTerminal: async (params) =>
				this.callRegisteredRequest(ACP_METHODS.TERMINAL_KILL, params),
			extMethod: async (method, params) =>
				this.callRegisteredRequest(method, params),
		};
	}

	private async handlePermissionRequest(
		request: PermissionRequest,
	): Promise<PermissionResponse> {
		const requestId = this.nextPermissionRequestId++;

		if (this._session && request.sessionId === this._session.sessionId) {
			this._session.handlePermissionRequest(request);
		}

		return new Promise((resolve) => {
			this.pendingPermissionRequests.set(requestId, { resolve });
			this.emit("permission_request", { requestId, ...request });
		});
	}

	private async handleSessionUpdate({
		sessionId,
		update,
	}: {
		sessionId: string;
		update: SessionUpdate;
	}): Promise<void> {
		if (this._session && sessionId === this._session.sessionId) {
			this.handleSessionControlUpdate(update);
			this._session.handleSessionUpdate(update);
			this.emit("session_update", update);
		}
	}

	private async callRegisteredRequest<T>(
		method: string,
		params: unknown,
	): Promise<T> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			throw RequestError.methodNotFound(method);
		}
		return (await handler(params)) as T;
	}

	private buildClientCapabilities(
		clientCapabilities: ClientCapabilities,
	): ClientCapabilities {
		const capabilities: ClientCapabilities = {
			...clientCapabilities,
			fs: { ...clientCapabilities.fs },
		};

		if (
			capabilities.fs &&
			capabilities.fs.readTextFile == null &&
			this.requestHandlers.has(ACP_METHODS.FS_READ_TEXT_FILE)
		) {
			capabilities.fs.readTextFile = true;
		}

		if (
			capabilities.fs &&
			capabilities.fs.writeTextFile == null &&
			this.requestHandlers.has(ACP_METHODS.FS_WRITE_TEXT_FILE)
		) {
			capabilities.fs.writeTextFile = true;
		}

		if (
			capabilities.terminal == null &&
			this.requestHandlers.has(ACP_METHODS.TERMINAL_CREATE) &&
			this.requestHandlers.has(ACP_METHODS.TERMINAL_OUTPUT) &&
			this.requestHandlers.has(ACP_METHODS.TERMINAL_RELEASE) &&
			this.requestHandlers.has(ACP_METHODS.TERMINAL_WAIT_FOR_EXIT) &&
			this.requestHandlers.has(ACP_METHODS.TERMINAL_KILL)
		) {
			capabilities.terminal = true;
		}

		return capabilities;
	}

	private getConnection(): ClientSideConnection {
		if (!this.connection) {
			throw new Error("ACP connection is not established");
		}
		return this.connection;
	}

	private async runWhileConnected<T>(promise: Promise<T>): Promise<T> {
		const transportHandle = this.transportHandle;
		if (!transportHandle) {
			throw new Error("ACP transport is not connected");
		}

		return await Promise.race([
			promise,
			transportHandle.closed.then((reason) => {
				throw new Error(reason || "Connection closed");
			}),
		]);
	}

	private resolveAllPermissionRequests(response: PermissionResponse): void {
		const pendingRequests = [...this.pendingPermissionRequests.values()];
		this.pendingPermissionRequests.clear();
		for (const pending of pendingRequests) {
			pending.resolve(response);
		}
	}

	private setSessionConfigurationState({
		modes,
		models,
		configOptions,
	}: {
		modes?: SessionModeState | null;
		models?: SessionModelState | null;
		configOptions?: SessionConfigOption[] | null;
	}): void {
		this._sessionModes = modes ?? null;
		this._sessionModels = models ?? null;
		this._sessionConfigOptions = this.normalizeConfigOptions(configOptions);
		this.emitSessionControlsUpdate();
	}

	private setSessionConfigOptions(
		configOptions: SessionConfigOption[] | null | undefined,
	): void {
		this._sessionConfigOptions = this.normalizeConfigOptions(configOptions);
		this.emitSessionControlsUpdate();
	}

	private updateSessionModeId(modeId: string): void {
		if (!this._sessionModes || this._sessionModes.currentModeId === modeId)
			return;

		this._sessionModes = {
			...this._sessionModes,
			currentModeId: modeId,
		};
		this.emitSessionControlsUpdate();
	}

	private updateSessionModelId(modelId: string): void {
		if (
			!this._sessionModels ||
			this._sessionModels.currentModelId === modelId
		) {
			return;
		}

		this._sessionModels = {
			...this._sessionModels,
			currentModelId: modelId,
		};
		this.emitSessionControlsUpdate();
	}

	private updateSessionConfigOptionValue(
		configId: string,
		value: string,
	): void {
		let didChange = false;
		this._sessionConfigOptions = this._sessionConfigOptions.map((option) => {
			if (option.id !== configId || option.currentValue === value) {
				return option;
			}
			didChange = true;
			return {
				...option,
				currentValue: value,
			};
		});

		if (didChange) {
			this.emitSessionControlsUpdate();
		}
	}

	private handleSessionControlUpdate(update: SessionUpdate): void {
		const updateKind = (update as { sessionUpdate?: string }).sessionUpdate;

		if (updateKind === "current_mode_update") {
			const modeUpdate = update as {
				currentModeId?: unknown;
				modeId?: unknown;
			};
			const modeId =
				typeof modeUpdate.currentModeId === "string"
					? modeUpdate.currentModeId
					: typeof modeUpdate.modeId === "string"
						? modeUpdate.modeId
						: null;
			if (modeId) {
				this.updateSessionModeId(modeId);
			}
			return;
		}

		if (
			updateKind === "config_option_update" ||
			updateKind === "config_options_update"
		) {
			const configUpdate = update as { configOptions?: unknown };
			if (Array.isArray(configUpdate.configOptions)) {
				this.setSessionConfigOptions(
					configUpdate.configOptions as SessionConfigOption[],
				);
			}
		}
	}

	private emitSessionControlsUpdate(): void {
		this.emit("session_controls_update", {
			modes: this._sessionModes,
			models: this._sessionModels,
			configOptions: this._sessionConfigOptions,
		});
	}

	private normalizeConfigOptions(
		configOptions: SessionConfigOption[] | null | undefined,
	): SessionConfigOption[] {
		return Array.isArray(configOptions) ? [...configOptions] : [];
	}

	private clearSessionConfigurationState(emit = false): void {
		this._sessionModes = null;
		this._sessionModels = null;
		this._sessionConfigOptions = [];
		if (emit) {
			this.emitSessionControlsUpdate();
		}
	}

	private ensureSessionId(): string {
		if (!this._session) {
			throw new Error("No active session. Call newSession() first.");
		}
		return this._session.sessionId;
	}

	private disposeSessionState(): void {
		this._session?.dispose();
		this._session = null;
		this._agentCapabilities = null;
		this._agentInfo = null;
		this.clearSessionConfigurationState();
	}

	private handleTransportClosed(reason?: string): void {
		if (!this.transportHandle && !this.connection) return;

		this.resolveAllPermissionRequests({
			outcome: {
				outcome: "cancelled",
			},
		});
		this.disposeSessionState();
		this.connection = null;
		this.transportHandle?.dispose();
		this.transportHandle = null;

		if (this._state !== ConnectionState.DISCONNECTED) {
			this.setState(ConnectionState.DISCONNECTED);
		}

		if (reason) {
			this.emit("error", new Error(reason));
		}
	}

	private ensureReady(): void {
		if (this._state !== ConnectionState.READY) {
			throw new Error(
				`Client is not ready (state: ${this._state}). Call connect() and initialize() first.`,
			);
		}
	}

	dispose(): void {
		void this.disconnect();
		this.listeners.clear();
		this.requestHandlers.clear();
	}
}
