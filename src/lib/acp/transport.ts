import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export type ErrorHandler = (error: Error) => void;
export type CloseHandler = (reason?: string) => void;

export interface TransportConfig {
	type: "websocket";
	url: string;
	timeout?: number;
}

export interface TransportHandle {
	stream: Stream;
	ready: Promise<void>;
	closed: Promise<string | undefined>;
	onError: ErrorHandler | null;
	onClose: CloseHandler | null;
	readonly connected: boolean;
	dispose: () => void;
}

const DEFAULT_TIMEOUT = 10000;

export function createTransport(config: TransportConfig): TransportHandle {
	switch (config.type) {
		case "websocket":
			return createWebSocketTransport(config);
		default:
			throw new Error(`Unsupported transport type: ${config.type}`);
	}
}

function createWebSocketTransport(config: TransportConfig): TransportHandle {
	const url = config.url;
	const timeout = config.timeout ?? DEFAULT_TIMEOUT;

	let socket: WebSocket | null = null;
	let disposed = false;
	let isConnected = false;
	let readableClosed = false;
	let closeResolved = false;
	let readableController: ReadableStreamDefaultController<AnyMessage> | null =
		null;

	let resolveClosed!: (reason?: string) => void;
	const closed = new Promise<string | undefined>((resolve) => {
		resolveClosed = (reason?: string) => {
			if (closeResolved) return;
			closeResolved = true;
			resolve(reason);
		};
	});

	const closeReadable = () => {
		if (readableClosed) return;
		readableClosed = true;
		readableController?.close();
		readableController = null;
	};

	const readable = new ReadableStream<AnyMessage>({
		start(controller) {
			readableController = controller;
		},
		cancel() {
			if (
				socket &&
				socket.readyState !== WebSocket.CLOSED &&
				socket.readyState !== WebSocket.CLOSING
			) {
				socket.close(1000, "Reader cancelled");
			}
		},
	});

	const writable = new WritableStream<AnyMessage>({
		write(message) {
			if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) {
				throw new Error("ACP transport is not connected");
			}
			socket.send(JSON.stringify(message));
		},
		close() {
			if (
				socket &&
				socket.readyState !== WebSocket.CLOSED &&
				socket.readyState !== WebSocket.CLOSING
			) {
				socket.close(1000, "Writer closed");
			}
		},
		abort(reason) {
			if (
				socket &&
				socket.readyState !== WebSocket.CLOSED &&
				socket.readyState !== WebSocket.CLOSING
			) {
				socket.close(1000, String(reason || "Writer aborted"));
			}
		},
	});

	const transport: TransportHandle = {
		stream: { readable, writable },
		ready: Promise.resolve(),
		closed,
		onError: null,
		onClose: null,

		get connected(): boolean {
			return isConnected;
		},

		dispose(): void {
			disposed = true;
			isConnected = false;
			transport.onError = null;
			transport.onClose = null;
			closeReadable();
			resolveClosed("Disposed");

			if (!socket) return;
			if (
				socket.readyState === WebSocket.OPEN ||
				socket.readyState === WebSocket.CONNECTING
			) {
				try {
					socket.close(1000, "Disposed");
				} catch {
					/* ignore */
				}
			}
			socket = null;
		},
	};

	socket = new WebSocket(url);

	transport.ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (socket) {
				socket.onopen = null;
				socket.onerror = null;
			}
			try {
				socket?.close();
			} catch {
				/* ignore */
			}
			reject(new Error(`ACP connection timed out for ${url}`));
		}, timeout);

		if (!socket) {
			clearTimeout(timer);
			reject(new Error("Failed to create WebSocket"));
			return;
		}

		socket.onopen = () => {
			clearTimeout(timer);
			isConnected = true;
			if (socket) {
				socket.onopen = null;
				socket.onerror = handleError;
			}
			resolve();
		};

		socket.onerror = (event: Event) => {
			clearTimeout(timer);
			const errorEvent = event as ErrorEvent;
			const reason = errorEvent?.message || "connection error";
			reject(new Error(`ACP WebSocket error: ${reason}`));
		};
	});

	transport.ready
		.then(() => {
			if (!socket) return;

			socket.onmessage = (event: MessageEvent) => {
				const raw = normalizeMessage(event.data);
				if (raw == null) return;

				try {
					readableController?.enqueue(JSON.parse(raw));
				} catch (error) {
					console.warn("[ACP Transport] Failed to parse message:", error);
				}
			};

			socket.onclose = (event: CloseEvent) => {
				isConnected = false;
				closeReadable();

				const reason =
					event.reason ||
					(event.wasClean
						? "Connection closed"
						: `Connection lost (code: ${event.code})`);

				resolveClosed(reason);

				if (!disposed) {
					transport.onClose?.(reason);
				}
			};
		})
		.catch(() => {
			/* handled by caller awaiting ready */
		});

	function handleError(event: Event) {
		if (disposed) return;
		const errorEvent = event as ErrorEvent;
		const reason = errorEvent?.message || "transport error";
		transport.onError?.(new Error(reason));
	}

	return transport;
}

function normalizeMessage(data: unknown): string | null {
	if (typeof data === "string") {
		return data;
	}

	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(data);
	}

	if (typeof Blob !== "undefined" && data instanceof Blob) {
		console.warn("[ACP Transport] Blob messages are not supported");
		return null;
	}

	return data == null ? null : String(data);
}
