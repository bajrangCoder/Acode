/**
 * Terminal Component using xtermjs or wterm
 * Provides a pluggable and customizable terminal interface
 */

import { WebSocketTransport, WTerm } from "@wterm/dom";
import "@wterm/dom/css";
import { GhosttyCore } from "@wterm/ghostty";
import { AttachAddon } from "@xterm/addon-attach";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as Xterm } from "@xterm/xterm";
import {
	executeCommand,
	getResolvedKeyBindings,
	getResolvedKeyBindingsVersion,
} from "cm/commandRegistry";
import toast from "components/toast";
import confirm from "dialogs/confirm";
import fonts from "lib/fonts";
import appSettings from "lib/settings";
import LigaturesAddon from "./ligatures";
import {
	DEFAULT_TERMINAL_SETTINGS,
	getTerminalSettings,
} from "./terminalDefaults";
import TerminalThemeManager from "./terminalThemeManager";
import TerminalTouchSelection from "./terminalTouchSelection";

export default class TerminalComponent {
	constructor(options = {}) {
		// Get terminal settings from shared defaults
		const terminalSettings = getTerminalSettings();

		this.options = {
			allowProposedApi: true,
			scrollOnUserInput: true,
			rows: options.rows || 24,
			cols: options.cols || 80,
			port: options.port || 8767,
			renderEngine: terminalSettings.renderEngine,
			wtermParser: terminalSettings.wtermParser,
			renderer: options.renderer || "auto", // 'auto' | 'canvas' | 'webgl'
			fontSize: terminalSettings.fontSize,
			fontFamily: terminalSettings.fontFamily,
			fontWeight: terminalSettings.fontWeight,
			theme: TerminalThemeManager.getTheme(terminalSettings.theme),
			cursorBlink: terminalSettings.cursorBlink,
			cursorStyle: terminalSettings.cursorStyle,
			cursorInactiveStyle: terminalSettings.cursorInactiveStyle,
			scrollback: terminalSettings.scrollback,
			tabStopWidth: terminalSettings.tabStopWidth,
			convertEol: terminalSettings.convertEol,
			letterSpacing: terminalSettings.letterSpacing,
			...options,
		};

		this.terminal = null;
		this.fitAddon = null;
		this.attachAddon = null;
		this.unicode11Addon = null;
		this.searchAddon = null;
		this.webLinksAddon = null;
		this.imageAddon = null;
		this.ligaturesAddon = null;
		this.container = null;
		this.websocket = null;
		this.transport = null;
		this.pid = null;
		this.isConnected = false;
		this.serverMode = options.serverMode !== false; // Default true
		this.touchSelection = null;
		this.isWterm = this.options.renderEngine === "wterm";
		this.isMounted = false;
		this.lastStableWtermSize = {
			cols: this.options.cols,
			rows: this.options.rows,
		};
		this.hasInitialWtermFit = false;
		this.boundWtermKeyHandler = null;
		this.parsedAppKeybindings = [];
		this.parsedAppKeybindingsVersion = -1;
		this.boundNativeSelectionMenuHandler = null;

		this.init();
	}

	init() {
		if (this.isWterm) return;

		this.terminal = new Xterm(this.options);

		// Initialize addons
		this.fitAddon = new FitAddon();
		this.unicode11Addon = new Unicode11Addon();
		this.searchAddon = new SearchAddon();
		this.webLinksAddon = new WebLinksAddon(async (event, uri) => {
			const linkOpenConfirm = await confirm(
				"Terminal",
				`Do you want to open ${uri} in browser?`,
			);
			if (linkOpenConfirm) {
				system.openInBrowser(uri);
			}
		});
		this.webglAddon = null;

		// Load addons
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.loadAddon(this.searchAddon);
		this.terminal.loadAddon(this.webLinksAddon);

		// Load conditional addons based on settings
		const terminalSettings = getTerminalSettings();

		// Load image addon if enabled
		if (terminalSettings.imageSupport) {
			this.loadImageAddon();
		}

		// Load font in background - apply when ready without blocking render
		this._fontReady = this.loadTerminalFont().then(() => {
			if (this.terminal) {
				this.terminal.options.fontFamily = this.options.fontFamily;
				this.terminal.refresh(0, this.terminal.rows - 1);
			}
		});

		// Set up terminal event handlers
		this.setupEventHandlers();
	}

	setupEventHandlers() {
		if (this.isWterm) return;

		// terminal resize handling
		this.setupResizeHandling();

		// Handle terminal title changes
		this.terminal.onTitleChange((title) => {
			this.onTitleChange?.(title);
		});

		// Handle bell
		this.terminal.onBell(() => {
			this.onBell?.();
		});

		// Handle copy/paste keybindings
		this.setupCopyPasteHandlers();

		// Handle custom OSC 7777 for acode CLI commands
		this.setupOscHandler();
	}

	/**
	 * Setup custom OSC handler for acode CLI integration
	 * OSC 7777 format: \e]7777;command;arg1;arg2;...\a
	 */
	setupOscHandler() {
		// Register custom OSC handler for ID 7777
		// Format: command;arg1;arg2;... where arg2 (path) may contain semicolons
		this.terminal.parser.registerOscHandler(7777, (data) => {
			this.handleOscCommand(data);
			return true;
		});
	}

	/**
	 * Handle OSC open command from acode CLI
	 * @param {string} type - "file" or "folder"
	 * @param {string} path - Path to open
	 */
	handleOscOpen(type, path) {
		if (!path) return;

		// Emit event for the app to handle
		this.onOscOpen?.(type, path);
	}

	/**
	 * Setup resize handling for keyboard events and content preservation
	 */
	setupResizeHandling() {
		let resizeTimeout = null;
		let lastKnownScrollPosition = 0;
		let isResizing = false;
		let resizeCount = 0;
		const RESIZE_DEBOUNCE = 100;
		const MAX_RAPID_RESIZES = 3;

		// Store original dimensions for comparison
		let originalRows = this.terminal.rows;
		let originalCols = this.terminal.cols;

		this.terminal.onResize((size) => {
			// Track resize events
			resizeCount++;
			isResizing = true;

			// Store current scroll position before resize
			if (this.terminal.buffer && this.terminal.buffer.active) {
				lastKnownScrollPosition = this.terminal.buffer.active.viewportY;
			}

			// Clear any existing timeout
			if (resizeTimeout) {
				clearTimeout(resizeTimeout);
			}

			// Debounced resize handling
			resizeTimeout = setTimeout(async () => {
				try {
					// Only proceed with server resize if dimensions actually changed significantly
					const rowDiff = Math.abs(size.rows - originalRows);
					const colDiff = Math.abs(size.cols - originalCols);

					// If this is a minor resize (likely intermediate state), skip server update
					if (rowDiff < 2 && colDiff < 2 && resizeCount > 1) {
						console.log("Skipping minor resize to prevent instability");
						isResizing = false;
						resizeCount = 0;
						return;
					}

					// Handle server resize
					if (this.serverMode) {
						await this.resizeTerminal(size.cols, size.rows);
					}

					// Handle keyboard resize cursor positioning
					const heightRatio = size.rows / originalRows;
					if (
						heightRatio < 0.75 &&
						this.terminal.buffer &&
						this.terminal.buffer.active
					) {
						// Keyboard resize detected - ensure cursor is visible
						const buffer = this.terminal.buffer.active;
						const cursorY = buffer.cursorY;
						const cursorViewportPos = buffer.baseY + cursorY;
						const viewportTop = buffer.viewportY;
						const viewportBottom = viewportTop + this.terminal.rows - 1;

						if (
							cursorViewportPos <= viewportTop + 1 ||
							cursorViewportPos >= viewportBottom - 1
						) {
							const targetScroll = Math.max(
								0,
								Math.min(
									buffer.length - this.terminal.rows,
									cursorViewportPos - Math.floor(this.terminal.rows * 0.25),
								),
							);
							this.terminal.scrollToLine(targetScroll);
						}
					} else {
						// Regular resize - preserve scroll position
						this.preserveViewportPosition(lastKnownScrollPosition);
					}

					// Update stored dimensions
					originalRows = size.rows;
					originalCols = size.cols;

					// Mark resize as complete
					isResizing = false;
					resizeCount = 0;

					// Notify touch selection if it exists
					if (this.touchSelection) {
						this.touchSelection.onTerminalResize(size);
					}
				} catch (error) {
					console.error("Resize handling failed:", error);
					isResizing = false;
					resizeCount = 0;
				}
			}, RESIZE_DEBOUNCE);
		});

		// Also handle viewport changes for scroll position preservation
		this.terminal.onData(() => {
			// If we're not resizing and user types, everything is stable
			if (!isResizing && this.terminal.buffer && this.terminal.buffer.active) {
				lastKnownScrollPosition = this.terminal.buffer.active.viewportY;
			}
		});
	}

	/**
	 * Preserve viewport position during resize to prevent jumping
	 */
	preserveViewportPosition(targetScrollPosition) {
		if (!this.terminal.buffer || !this.terminal.buffer.active) return;

		const buffer = this.terminal.buffer.active;
		const maxScroll = Math.max(0, buffer.length - this.terminal.rows);

		// Ensure scroll position is within valid bounds
		const safeScrollPosition = Math.min(targetScrollPosition, maxScroll);

		// Only adjust if we have significant content and the position differs
		if (
			buffer.length > this.terminal.rows &&
			buffer.viewportY !== safeScrollPosition
		) {
			this.terminal.scrollToLine(safeScrollPosition);
		}
	}

	/**
	 * Setup touch selection for mobile devices
	 */
	setupTouchSelection() {
		// Only initialize touch selection on mobile devices
		if (window.cordova && this.container) {
			const terminalSettings = getTerminalSettings();
			this.touchSelection = new TerminalTouchSelection(
				this.terminal,
				this.container,
				{
					tapHoldDuration:
						terminalSettings.touchSelectionTapHoldDuration || 600,
					moveThreshold: terminalSettings.touchSelectionMoveThreshold || 8,
					handleSize: terminalSettings.touchSelectionHandleSize || 24,
					hapticFeedback:
						terminalSettings.touchSelectionHapticFeedback !== false,
					showContextMenu:
						terminalSettings.touchSelectionShowContextMenu !== false,
					onFontSizeChange: (fontSize) => this.updateFontSize(fontSize),
				},
			);
		}
	}

	/**
	 * Parse app keybindings into a format usable by the keyboard handler
	 */
	parseAppKeybindings() {
		const version = getResolvedKeyBindingsVersion();
		if (this.parsedAppKeybindingsVersion === version) {
			return this.parsedAppKeybindings;
		}

		const parsedBindings = [];

		Object.entries(getResolvedKeyBindings()).forEach(([name, binding]) => {
			if (!binding.key) return;

			// Skip editor-only keybindings in terminal
			if (binding.editorOnly) return;

			// Handle multiple key combinations separated by |
			const keys = binding.key.split("|");

			keys.forEach((keyCombo) => {
				const parts = keyCombo.endsWith("-")
					? [...keyCombo.slice(0, -1).split("-").filter(Boolean), "-"]
					: keyCombo.split("-");
				const parsed = {
					name,
					ctrl: false,
					shift: false,
					alt: false,
					meta: false,
					key: "",
				};

				parts.forEach((part) => {
					const lowerPart = part.toLowerCase();
					if (lowerPart === "ctrl") {
						parsed.ctrl = true;
					} else if (lowerPart === "shift") {
						parsed.shift = true;
					} else if (lowerPart === "alt") {
						parsed.alt = true;
					} else if (lowerPart === "meta" || lowerPart === "cmd") {
						parsed.meta = true;
					} else {
						// This is the actual key
						parsed.key = part.toLowerCase();
					}
				});

				if (parsed.key) {
					parsedBindings.push(parsed);
				}
			});
		});

		this.parsedAppKeybindings = parsedBindings;
		this.parsedAppKeybindingsVersion = version;

		return this.parsedAppKeybindings;
	}

	/**
	 * Setup copy/paste keyboard handlers
	 */
	setupCopyPasteHandlers() {
		// Add keyboard event listener to terminal element
		this.terminal.attachCustomKeyEventHandler((event) => {
			return this.handleTerminalKeyEvent(event);
		});
	}

	handleTerminalKeyEvent(event) {
		// Check for Ctrl+Shift+C (copy)
		if (event.ctrlKey && event.shiftKey && event.key === "C") {
			event.preventDefault();
			this.copySelection();
			return false;
		}

		// Check for Ctrl+Shift+V (paste)
		if (event.ctrlKey && event.shiftKey && event.key === "V") {
			event.preventDefault();
			this.pasteFromClipboard();
			return false;
		}

		// Keep terminal font zoom local. Shift variants are handled by app keybindings below.
		if (
			event.ctrlKey &&
			!event.shiftKey &&
			!event.altKey &&
			!event.metaKey &&
			(event.key === "+" || event.key === "=")
		) {
			event.preventDefault();
			this.increaseFontSize();
			return false;
		}

		if (
			event.ctrlKey &&
			!event.shiftKey &&
			!event.altKey &&
			!event.metaKey &&
			event.key === "-"
		) {
			event.preventDefault();
			this.decreaseFontSize();
			return false;
		}

		if (event.ctrlKey || event.altKey || event.metaKey) {
			if (["Control", "Alt", "Meta", "Shift"].includes(event.key)) {
				return true;
			}

			const appKeybindings = this.parseAppKeybindings();
			const eventKey = event.key === "_" ? "-" : event.key.toLowerCase();
			const binding = appKeybindings.find(
				(binding) =>
					binding.ctrl === event.ctrlKey &&
					binding.shift === event.shiftKey &&
					binding.alt === event.altKey &&
					binding.meta === event.metaKey &&
					binding.key === eventKey,
			);

			if (binding && executeCommand(binding.name)) {
				event.preventDefault();
				return false;
			}
		}

		if (event.ctrlKey || event.altKey || event.metaKey) return true;

		// Return true to allow normal processing for other keys
		return true;
	}

	/**
	 * Copy selected text to clipboard
	 */
	copySelection() {
		if (this.isWterm) {
			const selectedStr = window.getSelection?.()?.toString();
			if (selectedStr && cordova?.plugins?.clipboard) {
				cordova.plugins.clipboard.copy(selectedStr);
			}
			return;
		}
		if (!this.terminal?.hasSelection()) return;
		const selectedStr = this.terminal?.getSelection();
		if (selectedStr && cordova?.plugins?.clipboard) {
			cordova.plugins.clipboard.copy(selectedStr);
		}
	}

	/**
	 * Paste text from clipboard
	 */
	pasteFromClipboard() {
		if (cordova?.plugins?.clipboard) {
			cordova.plugins.clipboard.paste((text) => {
				this.paste(text);
			});
		}
	}

	/**
	 * Create terminal container element
	 * @returns {HTMLElement} Container element
	 */
	createContainer() {
		this.container = document.createElement("div");
		this.container.className = "terminal-container";
		this.container.style.cssText = `
      width: 100%;
      height: 100%;
      position: relative;
      background: ${this.options.theme.background};
      overflow: hidden;
      box-sizing: border-box;
    `;
		if (!this.isWterm) {
			this.disableNativeSelectionMenu(this.container);
		}

		return this.container;
	}

	/**
	 * Mount terminal to container
	 * @param {HTMLElement} container - Container element
	 */
	async mount(container) {
		if (!container) {
			container = this.createContainer();
		}

		this.container = container;

		// Apply terminal background color to container to match theme
		this.container.style.background = this.options.theme.background;
		if (!this.isWterm) {
			this.disableNativeSelectionMenu(this.container);
		}

		try {
			if (this.isWterm) {
				await this.mountWterm(container);
				return container;
			}

			// Open first to ensure a stable renderer is attached
			this.terminal.open(container);

			// Renderer selection: 'canvas' (default core), 'webgl', or 'auto'
			if (
				this.options.renderer === "webgl" ||
				this.options.renderer === "auto"
			) {
				try {
					const addon = new WebglAddon();
					this.terminal.loadAddon(addon);
					if (typeof addon.onContextLoss === "function") {
						addon.onContextLoss(() => this._handleWebglContextLoss());
					}
					this.webglAddon = addon;
				} catch (error) {
					console.error("Failed to enable WebGL renderer:", error);
					try {
						this.webglAddon?.dispose?.();
					} catch {}
					this.webglAddon = null; // stay on canvas
				}
			}
			const terminalSettings = getTerminalSettings();
			// Load ligatures addon if enabled
			if (terminalSettings.fontLigatures) {
				this.loadLigaturesAddon();
			}

			// First render pass: schedule a fit + focus once the frame is ready
			if (typeof requestAnimationFrame === "function") {
				requestAnimationFrame(() => {
					if (!this.terminal) return;
					this.fitAddon.fit();
					this.terminal.focus();
					this.setupTouchSelection();
				});
			} else {
				setTimeout(() => {
					if (!this.terminal) return;
					this.fitAddon.fit();
					this.terminal.focus();
					this.setupTouchSelection();
				}, 0);
			}

			// Safety: re-apply fontFamily on next frame to ensure xterm
			// uses correct metrics even if font wasn't ready for first paint
			if (typeof requestAnimationFrame === "function") {
				requestAnimationFrame(() => {
					if (this.terminal) {
						this.terminal.options.fontFamily = this.options.fontFamily;
						this.terminal.refresh(0, this.terminal.rows - 1);
					}
				});
			} else {
				setTimeout(() => {
					if (this.terminal) {
						this.terminal.options.fontFamily = this.options.fontFamily;
						this.terminal.refresh(0, this.terminal.rows - 1);
					}
				}, 16);
			}
		} catch (error) {
			console.error("Failed to mount terminal:", error);
		}

		return container;
	}

	async mountWterm(container) {
		this.applyWtermCssVariables();
		container.classList.add("terminal-wterm");
		container.classList.remove("terminal-native-selection-disabled");

		let core;
		if (this.options.wtermParser === "ghostty") {
			try {
				core = await GhosttyCore.load();
			} catch (error) {
				console.error("Failed to load wterm Ghostty core:", error);
				throw new Error(
					`Failed to load wterm Ghostty parser: ${error?.message || error}`,
				);
			}
		}

		this.terminal = new WTerm(container, {
			cols: this.options.cols,
			rows: this.options.rows,
			core,
			autoResize: false,
			cursorBlink: this.options.cursorBlink,
			onTitle: (title) => {
				this.onTitleChange?.(title);
			},
			onResize: (cols, rows) => {
				if (this.serverMode) {
					this.resizeTerminal(cols, rows);
				}
			},
			onData: (data) => {
				if (this.serverMode && this.transport) {
					this.transport.send(data);
				} else {
					this.terminal?.write(data);
				}
			},
		});

		await this.loadTerminalFont();
		await this.terminal.init();
		container.style.height = "100%";
		this.fitWterm({ resizeRows: true });
		this.hasInitialWtermFit = true;
		this.isMounted = true;

		this.boundWtermKeyHandler = (event) => {
			if (this.handleTerminalKeyEvent(event) === false) {
				event.stopPropagation();
			}
		};
		container.addEventListener("keydown", this.boundWtermKeyHandler, true);

		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => {
				this.focus();
			});
		} else {
			setTimeout(() => {
				this.focus();
			}, 0);
		}
	}

	/**
	 * Disable the platform/browser text-selection menu in terminal views.
	 * Terminal selection is handled by TerminalTouchSelection and xterm APIs.
	 */
	disableNativeSelectionMenu(container) {
		if (!container) return;

		container.classList.add("terminal-native-selection-disabled");

		if (this.boundNativeSelectionMenuHandler) {
			container.removeEventListener(
				"contextmenu",
				this.boundNativeSelectionMenuHandler,
				true,
			);
		}

		this.boundNativeSelectionMenuHandler = (event) => {
			if (event.target?.closest?.(".terminal-context-menu")) return;
			event.preventDefault();
			event.stopPropagation();
		};

		container.addEventListener(
			"contextmenu",
			this.boundNativeSelectionMenuHandler,
			true,
		);
	}

	/**
	 * Create new terminal session using global Terminal API
	 * @returns {Promise<string>} Terminal PID
	 */
	async createSession() {
		if (!this.serverMode) {
			throw new Error(
				"Terminal is in local mode, cannot create server session",
			);
		}

		try {
			// Check if terminal is installed before starting AXS
			if (!(await Terminal.isInstalled())) {
				throw new Error(
					"Terminal not installed. Please install terminal first.",
				);
			}

			// Start AXS if not running
			if (!(await Terminal.isAxsRunning())) {
				const values = appSettings.value;
				// Initialize terminal settings with defaults if not present
				if (!values.terminalSettings) {
					values.terminalSettings = {
						...DEFAULT_TERMINAL_SETTINGS,
						fontFamily:
							DEFAULT_TERMINAL_SETTINGS.fontFamily ||
							appSettings.value.fontFamily,
					};
				}

				const terminalValues = values.terminalSettings;

				await Terminal.startAxs(
					false,
					() => {},
					console.error,
					terminalValues.failsafeMode,
				);

				// Check if AXS started with interval polling
				const maxRetries = 10;
				let retries = 0;
				while (retries < maxRetries) {
					await new Promise((resolve) => setTimeout(resolve, 1000));
					if (await Terminal.isAxsRunning()) {
						break;
					}
					retries++;
				}

				// If AXS still not running after retries, throw error
				if (!(await Terminal.isAxsRunning())) {
					toast("Failed to start AXS server after multiple attempts");
					//throw new Error("Failed to start AXS server after multiple attempts");
				}
			}

			const { cols, rows } = this.getSize();
			const requestBody = {
				cols,
				rows,
			};

			const response = await new Promise((resolve, reject) => {
				cordova.plugin.http.sendRequest(
					`http://localhost:${this.options.port}/terminals`,
					{
						method: "POST",
						responseType: "text",
						serializer: "json",
						data: requestBody,
					},
					(res) => resolve(res),
					(err) => reject(new Error(err.error || `HTTP error!`)),
				);
			});

			if (response.status < 200 || response.status >= 300) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			this.pid = response.data.trim();
			return this.pid;
		} catch (error) {
			console.error("Failed to create terminal session:", error);
			throw error;
		}
	}

	/**
	 * Connect to terminal session via WebSocket
	 * @param {string} pid - Terminal PID
	 */
	async connectToSession(pid) {
		if (!this.serverMode) {
			throw new Error(
				"Terminal is in local mode, cannot connect to server session",
			);
		}

		if (!pid) {
			pid = await this.createSession();
		}

		this.pid = pid;

		const wsUrl = `ws://localhost:${this.options.port}/terminals/${pid}`;

		if (this.isWterm) {
			await this.connectWtermTransport(wsUrl, pid);
			return;
		}

		await new Promise((resolve, reject) => {
			const websocket = new WebSocket(wsUrl);
			const CONNECT_TIMEOUT = 5000;
			let settled = false;
			let hasOpened = false;

			this.websocket = websocket;

			const rejectInitialConnect = (message, error) => {
				if (settled || hasOpened) return;
				settled = true;
				this.isConnected = false;
				try {
					websocket.close();
				} catch {}
				reject(error || new Error(message));
			};

			const connectionTimeout = setTimeout(() => {
				rejectInitialConnect(
					`Timed out while connecting to terminal session ${pid}`,
				);
			}, CONNECT_TIMEOUT);

			websocket.onopen = () => {
				clearTimeout(connectionTimeout);
				hasOpened = true;
				this.isConnected = true;
				this.onConnect?.();

				// Load attach addon after connection
				this.attachAddon = new AttachAddon(websocket);
				this.terminal.loadAddon(this.attachAddon);
				this.terminal.unicode.activeVersion = "11";

				// Focus terminal and ensure it's ready
				this.terminal.focus();
				this.fit();

				if (!settled) {
					settled = true;
					resolve();
				}
			};

			websocket.onmessage = (event) => {
				// Handle text messages (exit events)
				if (typeof event.data === "string") {
					try {
						const message = JSON.parse(event.data);
						if (message.type === "exit") {
							this.onProcessExit?.(message.data);
							return;
						}
					} catch (error) {
						// Not a JSON message, let attachAddon handle it
					}
				}
				// For binary data or non-exit text messages, let attachAddon handle them
			};

			websocket.onclose = (event) => {
				clearTimeout(connectionTimeout);
				this.isConnected = false;

				if (!hasOpened) {
					const code = event?.code ? ` (code ${event.code})` : "";
					const reason = event?.reason ? `: ${event.reason}` : "";
					rejectInitialConnect(
						`Terminal session ${pid} is unavailable${code}${reason}`,
					);
					return;
				}

				this.onDisconnect?.();
			};

			websocket.onerror = (error) => {
				if (!hasOpened) {
					clearTimeout(connectionTimeout);
					rejectInitialConnect(
						`Failed to connect to terminal session ${pid}`,
						new Error(`Failed to connect to terminal session ${pid}`),
					);
					return;
				}

				console.error("WebSocket error:", error);
				this.onError?.(error);
			};
		});
	}

	async connectWtermTransport(wsUrl, pid) {
		await new Promise((resolve, reject) => {
			const CONNECT_TIMEOUT = 5000;
			let settled = false;
			let hasOpened = false;

			const rejectInitialConnect = (message, error) => {
				if (settled || hasOpened) return;
				settled = true;
				this.isConnected = false;
				try {
					this.transport?.close?.();
				} catch {}
				reject(error || new Error(message));
			};

			const connectionTimeout = setTimeout(() => {
				rejectInitialConnect(
					`Timed out while connecting to terminal session ${pid}`,
				);
			}, CONNECT_TIMEOUT);

			this.transport = new WebSocketTransport({
				url: wsUrl,
				reconnect: true,
				onData: (data) => {
					const payload = this.extractAcodeOscCommands(data);
					if (payload == null || payload === "") return;

					if (typeof payload === "string") {
						try {
							const message = JSON.parse(payload);
							if (message.type === "exit") {
								this.onProcessExit?.(message.data);
								return;
							}
						} catch (error) {
							// Not a JSON control message; write it to wterm.
						}
					}

					this.terminal?.write(payload);
				},
				onOpen: () => {
					clearTimeout(connectionTimeout);
					hasOpened = true;
					this.isConnected = true;
					this.onConnect?.();
					this.focus();
					this.fit();

					if (!settled) {
						settled = true;
						resolve();
					}
				},
				onClose: () => {
					clearTimeout(connectionTimeout);
					this.isConnected = false;

					if (!hasOpened) {
						rejectInitialConnect(`Terminal session ${pid} is unavailable`);
						return;
					}

					this.onDisconnect?.();
				},
				onError: (error) => {
					if (!hasOpened) {
						clearTimeout(connectionTimeout);
						rejectInitialConnect(
							`Failed to connect to terminal session ${pid}`,
							new Error(`Failed to connect to terminal session ${pid}`),
						);
						return;
					}

					console.error("WebSocket transport error:", error);
					this.onError?.(error);
				},
			});

			this.transport.connect();
		});
	}

	/**
	 * Resize terminal
	 * @param {number} cols - Number of columns
	 * @param {number} rows - Number of rows
	 */
	async resizeTerminal(cols, rows) {
		if (!this.pid || !this.serverMode) return;

		try {
			await new Promise((resolve, reject) => {
				cordova.plugin.http.sendRequest(
					`http://localhost:${this.options.port}/terminals/${this.pid}/resize`,
					{
						method: "POST",
						serializer: "json",
						data: { cols, rows },
					},
					(res) => resolve(res),
					(err) => reject(err),
				);
			});
		} catch (error) {
			console.error("Failed to resize terminal:", error);
		}
	}

	/**
	 * Fit terminal to container
	 */
	fit() {
		if (this.isWterm) {
			this.fitWterm({ resizeRows: !this.hasInitialWtermFit });
		} else if (this.fitAddon) {
			this.fitAddon.fit();
		}
	}

	fitWterm(options = {}) {
		if (!this.terminal || !this.container) return;

		try {
			const measured = this.terminal._measureCharSize?.();
			if (!measured) return;

			const rect = this.container.getBoundingClientRect();
			const style = getComputedStyle(this.container);
			const horizontalPadding =
				(Number.parseFloat(style.paddingLeft) || 0) +
				(Number.parseFloat(style.paddingRight) || 0);
			const verticalPadding =
				(Number.parseFloat(style.paddingTop) || 0) +
				(Number.parseFloat(style.paddingBottom) || 0);
			const contentWidth = rect.width - horizontalPadding;
			const contentHeight = rect.height - verticalPadding;

			if (contentWidth <= 0 || contentHeight <= 0) return;

			const cols = Math.max(1, Math.floor(contentWidth / measured.charWidth));
			const measuredRows = Math.max(
				1,
				Math.floor(contentHeight / measured.rowHeight),
			);

			// Android keyboard transitions can briefly report unstable dimensions.
			// Do not let one bad measurement collapse the terminal to a single column.
			if (cols < 10 || measuredRows < 3) return;

			const rows = options.resizeRows ? measuredRows : this.terminal.rows;
			if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
				this.lastStableWtermSize = { cols, rows };
				this.terminal.resize(cols, rows);
			}
		} catch (error) {
			console.error("Failed to fit wterm:", error);
		}
	}

	/**
	 * Write data to terminal
	 * @param {string} data - Data to write
	 */
	write(data) {
		if (this.isWterm) {
			if (this.serverMode && this.isConnected && this.transport) {
				this.transport.send(data);
			} else {
				this.terminal?.write(data);
			}
		} else if (
			this.serverMode &&
			this.isConnected &&
			this.websocket &&
			this.websocket.readyState === WebSocket.OPEN
		) {
			// Send data through WebSocket instead of direct write
			this.websocket.send(data);
		} else {
			// For local mode or disconnected terminals, write directly
			this.terminal.write(data);
		}
	}

	/**
	 * Write line to terminal
	 * @param {string} data - Data to write
	 */
	writeln(data) {
		this.terminal?.write(`${data}\r\n`);
	}

	/**
	 * Clear terminal
	 */
	clear() {
		if (this.isWterm) {
			const { cols, rows } = this.getSize();
			if (this.container && this.boundWtermKeyHandler) {
				this.container.removeEventListener(
					"keydown",
					this.boundWtermKeyHandler,
					true,
				);
				this.boundWtermKeyHandler = null;
			}
			this.terminal?.destroy();
			this.terminal = null;
			this.options.cols = cols;
			this.options.rows = rows;
			if (this.container) {
				void this.mountWterm(this.container);
			}
			return;
		}
		this.terminal?.clear();
	}

	/**
	 * Focus terminal
	 */
	focus() {
		this.terminal?.focus();
	}

	/**
	 * Blur terminal
	 */
	blur() {
		this.terminal?.blur?.();
	}

	/**
	 * Search in terminal
	 * @param {string} term - Search term
	 * @param {number} skip Number of search results to skip
	 * @param {boolean} backward Whether to search backward
	 */
	search(term, skip, backward) {
		if (this.searchAddon) {
			const searchOptions = {
				regex: appSettings.value.search.regExp || false,
				wholeWord: appSettings.value.search.wholeWord || false,
				caseSensitive: appSettings.value.search.caseSensitive || false,
				decorations: {
					matchBorder: "#FFA500",
					activeMatchBorder: "#FFFF00",
				},
			};
			if (!term) {
				return false;
			}

			if (backward) {
				return this.searchAddon.findPrevious(term, searchOptions);
			} else {
				return this.searchAddon.findNext(term, searchOptions);
			}
		}
		return false;
	}

	/**
	 * Update terminal theme
	 * @param {object|string} theme - Theme object or theme name
	 */
	updateTheme(theme) {
		if (typeof theme === "string") {
			theme = TerminalThemeManager.getTheme(theme);
		}
		this.options.theme = { ...this.options.theme, ...theme };
		if (this.isWterm) {
			this.applyWtermCssVariables();
			if (this.container) {
				this.container.style.background = this.options.theme.background;
			}
		} else if (this.terminal) {
			this.terminal.options.theme = this.options.theme;
		}
	}

	/**
	 * Update terminal options
	 * @param {object} options - Options to update
	 */
	updateOptions(options) {
		Object.keys(options).forEach((key) => {
			this.updateOption(key, options[key]);
		});
	}

	updateOption(key, value) {
		if (key === "theme") {
			this.updateTheme(value);
			return;
		}

		this.options[key] = value;

		if (this.isWterm) {
			switch (key) {
				case "fontSize":
				case "fontFamily":
				case "fontWeight":
					this.applyWtermCssVariables();
					this.fit();
					break;
				case "cursorBlink":
					this.container?.classList.toggle("cursor-blink", Boolean(value));
					break;
			}
			return;
		}

		if (this.terminal?.options) {
			this.terminal.options[key] = value;
		}
	}

	getInputElement() {
		if (this.isWterm) {
			return (
				this.terminal?.input?.textarea ||
				this.container?.querySelector?.("[contenteditable='true']") ||
				this.container
			);
		}
		return this.terminal?.textarea || null;
	}

	getSize() {
		return {
			cols: this.terminal?.cols || this.options.cols || 80,
			rows: this.terminal?.rows || this.options.rows || 24,
		};
	}

	proposeDimensions() {
		if (this.fitAddon?.proposeDimensions) {
			return this.fitAddon.proposeDimensions();
		}

		if (!this.isWterm || !this.container || !this.terminal) return null;

		const measured = this.terminal._measureCharSize?.();
		if (!measured) return null;

		const rect = this.container.getBoundingClientRect();
		const style = getComputedStyle(this.container);
		const horizontalPadding =
			(Number.parseFloat(style.paddingLeft) || 0) +
			(Number.parseFloat(style.paddingRight) || 0);
		const verticalPadding =
			(Number.parseFloat(style.paddingTop) || 0) +
			(Number.parseFloat(style.paddingBottom) || 0);
		const cols = Math.max(
			1,
			Math.floor((rect.width - horizontalPadding) / measured.charWidth),
		);
		const rows = Math.max(
			1,
			Math.floor((rect.height - verticalPadding) / measured.rowHeight),
		);

		if (cols < 10 || rows < 3) {
			return this.lastStableWtermSize;
		}

		return { cols, rows };
	}

	paste(text) {
		if (this.isWterm) {
			if (this.serverMode && this.isConnected && this.transport) {
				this.transport.send(String(text ?? ""));
			} else {
				this.terminal?.write(String(text ?? ""));
			}
			return;
		}
		this.terminal?.paste?.(text);
	}

	/**
	 * Load image addon
	 */
	loadImageAddon() {
		if (!this.imageAddon) {
			try {
				this.imageAddon = new ImageAddon();
				this.terminal.loadAddon(this.imageAddon);
			} catch (error) {
				console.error("Failed to load ImageAddon:", error);
			}
		}
	}

	/**
	 * Dispose image addon
	 */
	disposeImageAddon() {
		if (this.imageAddon) {
			try {
				this.imageAddon.dispose();
				this.imageAddon = null;
			} catch (error) {
				console.error("Failed to dispose ImageAddon:", error);
			}
		}
	}

	/**
	 * Update image support setting
	 * @param {boolean} enabled - Whether to enable image support
	 */
	updateImageSupport(enabled) {
		if (enabled) {
			this.loadImageAddon();
		} else {
			this.disposeImageAddon();
		}
	}

	/**
	 * Load ligatures addon
	 */
	loadLigaturesAddon() {
		if (!this.ligaturesAddon) {
			try {
				this.ligaturesAddon = new LigaturesAddon();
				this.terminal.loadAddon(this.ligaturesAddon);
			} catch (error) {
				console.error("Failed to load LigaturesAddon:", error);
			}
		}
	}

	/**
	 * Dispose ligatures addon
	 */
	disposeLigaturesAddon() {
		if (this.ligaturesAddon) {
			try {
				this.ligaturesAddon.dispose();
				this.ligaturesAddon = null;
			} catch (error) {
				console.error("Failed to dispose LigaturesAddon:", error);
			}
		}
	}

	/**
	 * Update font ligatures setting
	 * @param {boolean} enabled - Whether to enable font ligatures
	 */
	updateFontLigatures(enabled) {
		if (this.isWterm) return;
		if (enabled) {
			this.loadLigaturesAddon();
		} else {
			this.disposeLigaturesAddon();
		}
	}

	/**
	 * Load terminal font if it's not already loaded
	 */
	async loadTerminalFont() {
		const fontFamily = this.options.fontFamily;
		if (fontFamily && fonts.get(fontFamily)) {
			try {
				fonts.injectFontFace(fontFamily);
				await fonts.loadFont(fontFamily);
			} catch (error) {
				console.warn(`Failed to load terminal font ${fontFamily}:`, error);
			}
		}
	}

	/**
	 * Increase terminal font size
	 */
	increaseFontSize() {
		const currentSize = this.options.fontSize;
		const newSize = Math.min(currentSize + 1, 24); // Max font size 24
		this.updateFontSize(newSize);
	}

	/**
	 * Decrease terminal font size
	 */
	decreaseFontSize() {
		const currentSize = this.options.fontSize;
		const newSize = Math.max(currentSize - 1, 8); // Min font size 8
		this.updateFontSize(newSize);
	}

	/**
	 * Update terminal font size and refresh display
	 */
	updateFontSize(fontSize) {
		if (fontSize === this.options.fontSize) return;

		this.updateOption("fontSize", fontSize);

		// Update terminal settings properly
		const currentSettings = appSettings.value.terminalSettings || {};
		const updatedSettings = { ...currentSettings, fontSize };
		appSettings.update({ terminalSettings: updatedSettings }, false);

		// Refresh terminal display
		this.terminal?.refresh?.(0, this.terminal.rows - 1);

		// Fit terminal to container after font size change to prevent empty space
		setTimeout(() => {
			if (this.fitAddon) {
				this.fitAddon.fit();
			}
		}, 50);

		// Update touch selection cell dimensions if it exists
		if (this.touchSelection) {
			setTimeout(() => {
				this.touchSelection.updateCellDimensions();
			}, 100);
		}
	}

	/**
	 * Terminate terminal session
	 */
	async terminate() {
		if (this.transport) {
			try {
				this.transport.close();
			} catch {}
			this.transport = null;
		}

		if (this.websocket) {
			this.websocket.close();
		}

		if (this.pid && this.serverMode) {
			try {
				await new Promise((resolve, reject) => {
					cordova.plugin.http.sendRequest(
						`http://localhost:${this.options.port}/terminals/${this.pid}/terminate`,
						{
							method: "POST",
							data: {}, // Added empty object to satisfy the plugin's type checker
						},
						(res) => resolve(res),
						(err) => reject(err),
					);
				});
			} catch (error) {
				console.error("Failed to terminate terminal:", error);
			}
		}
	}

	/**
	 * Dispose terminal
	 */
	dispose() {
		this.terminate();

		// Dispose touch selection
		if (this.touchSelection) {
			this.touchSelection.destroy();
			this.touchSelection = null;
		}

		// Dispose addons
		this.disposeImageAddon();
		this.disposeLigaturesAddon();

		if (this.terminal) {
			if (this.isWterm) {
				this.terminal.destroy();
			} else {
				this.terminal.dispose();
			}
		}

		if (this.container && this.boundWtermKeyHandler) {
			this.container.removeEventListener(
				"keydown",
				this.boundWtermKeyHandler,
				true,
			);
			this.boundWtermKeyHandler = null;
		}

		if (this.container && this.boundNativeSelectionMenuHandler) {
			this.container.removeEventListener(
				"contextmenu",
				this.boundNativeSelectionMenuHandler,
				true,
			);
			this.boundNativeSelectionMenuHandler = null;
		}

		if (this.container) {
			this.container.remove();
		}
	}

	// Event handlers (can be overridden)
	onConnect() {}
	onDisconnect() {}
	onError(error) {}
	onTitleChange(title) {}
	onBell() {}
	onProcessExit(exitData) {}
}

TerminalComponent.prototype.applyWtermCssVariables = function () {
	if (!this.container) return;

	const variables = TerminalThemeManager.getWtermCssVariables(
		this.options.theme,
		{
			fontFamily: this.options.fontFamily,
			fontSize: this.options.fontSize,
			fontWeight: this.options.fontWeight,
		},
	);

	Object.entries(variables).forEach(([key, value]) => {
		this.container.style.setProperty(key, value);
	});
};

TerminalComponent.prototype.extractAcodeOscCommands = function (data) {
	let text = data;

	if (data instanceof Uint8Array) {
		text = new TextDecoder().decode(data);
	}

	if (typeof text !== "string") return data;

	return text.replace(/\x1b\]7777;([\s\S]*?)(?:\x07|\x1b\\)/g, (_, command) => {
		this.handleOscCommand(command);
		return "";
	});
};

TerminalComponent.prototype.handleOscCommand = function (data) {
	const firstSemi = data.indexOf(";");
	if (firstSemi === -1) {
		console.warn("Invalid OSC 7777 format:", data);
		return;
	}

	const command = data.substring(0, firstSemi);
	const rest = data.substring(firstSemi + 1);

	switch (command) {
		case "open": {
			const secondSemi = rest.indexOf(";");
			if (secondSemi === -1) {
				console.warn("Invalid OSC 7777 open format:", data);
				return;
			}
			const type = rest.substring(0, secondSemi);
			const path = rest.substring(secondSemi + 1);
			this.handleOscOpen(type, path);
			break;
		}
		default:
			console.warn("Unknown OSC 7777 command:", command);
	}
};

// Internal helpers for WebGL renderer lifecycle
TerminalComponent.prototype._handleWebglContextLoss = function () {
	try {
		console.warn("WebGL context lost; terminal rendering will be degraded");
		try {
			this.webglAddon?.dispose?.();
		} catch {}
		this.webglAddon = null;
	} catch (e) {
		console.error("Error handling WebGL context loss:", e);
	}
};
