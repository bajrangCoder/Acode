/**
 * Terminal Manager
 * Handles terminal session creation and management
 */

import EditorFile from "lib/editorFile";
import TerminalComponent from "./terminal";
import "@xterm/xterm/css/xterm.css";

class TerminalManager {
	constructor() {
		this.terminals = new Map();
		this.terminalCounter = 0;
	}

	/**
	 * Create a new terminal session
	 * @param {object} options - Terminal options
	 * @returns {Promise<object>} Terminal instance info
	 */
	async createTerminal(options = {}) {
		try {
			const terminalId = `terminal_${++this.terminalCounter}`;
			const terminalName = options.name || `Terminal ${this.terminalCounter}`;

			// Check if terminal is installed before proceeding
			if (options.serverMode !== false) {
				const installationResult = await this.checkAndInstallTerminal();
				if (!installationResult.success) {
					throw new Error(installationResult.error);
				}
			}

			// Create terminal component
			const terminalComponent = new TerminalComponent({
				serverMode: options.serverMode !== false,
				...options,
			});

			// Create container
			const terminalContainer = tag("div", {
				className: "terminal-content",
				id: `terminal-${terminalId}`,
			});

			// Terminal styles
			const terminalStyles = this.getTerminalStyles();
			const terminalStyle = tag("style", {
				textContent: terminalStyles,
			});
			document.body.appendChild(terminalStyle);

			// Create EditorFile for terminal
			const terminalFile = new EditorFile(terminalName, {
				type: "terminal",
				content: terminalContainer,
				tabIcon: "icon terminal",
				render: true,
			});

			// Wait for tab creation and setup
			const terminalInstance = await new Promise((resolve, reject) => {
				setTimeout(async () => {
					try {
						// Mount terminal component
						terminalComponent.mount(terminalContainer);

						// Connect to session if in server mode
						if (terminalComponent.serverMode) {
							await terminalComponent.connectToSession();
						} else {
							// For local mode, just write a welcome message
							terminalComponent.write(
								"Local terminal mode - ready for output\r\n",
							);
						}

						// Use PID as unique ID if available, otherwise fall back to terminalId
						const uniqueId = terminalComponent.pid || terminalId;

						// Setup event handlers
						this.setupTerminalHandlers(
							terminalFile,
							terminalComponent,
							uniqueId,
						);

						const instance = {
							id: uniqueId,
							name: terminalName,
							component: terminalComponent,
							file: terminalFile,
							container: terminalContainer,
						};

						this.terminals.set(uniqueId, instance);
						resolve(instance);
					} catch (error) {
						console.error("Failed to initialize terminal:", error);
						reject(error);
					}
				}, 100);
			});

			return terminalInstance;
		} catch (error) {
			console.error("Failed to create terminal:", error);
			throw error;
		}
	}

	/**
	 * Check if terminal is installed and install if needed
	 * @returns {Promise<{success: boolean, error?: string}>}
	 */
	async checkAndInstallTerminal() {
		try {
			// Check if terminal is already installed
			const isInstalled = await Terminal.isInstalled();
			if (isInstalled) {
				return { success: true };
			}

			// Check if terminal is supported on this device
			const isSupported = await Terminal.isSupported();
			if (!isSupported) {
				return {
					success: false,
					error: "Terminal is not supported on this device architecture",
				};
			}

			// Create installation progress terminal
			const installTerminal = await this.createInstallationTerminal();

			// Install terminal with progress logging
			await Terminal.install(
				(message) => {
					installTerminal.component.write(`${message}\r\n`);
				},
				(error) => {
					installTerminal.component.write(`\x1b[31mError: ${error}\x1b[0m\r\n`);
				},
			);
			return { success: true };
		} catch (error) {
			console.error("Terminal installation failed:", error);
			return {
				success: false,
				error: `Terminal installation failed: ${error.message}`,
			};
		}
	}

	/**
	 * Create a terminal for showing installation progress
	 * @returns {Promise<object>} Installation terminal instance
	 */
	async createInstallationTerminal() {
		const terminalId = `install_terminal_${++this.terminalCounter}`;
		const terminalName = "Terminal Installation";

		// Create terminal component in local mode (no server needed)
		const terminalComponent = new TerminalComponent({
			serverMode: false,
		});

		// Create container
		const terminalContainer = tag("div", {
			className: "terminal-content",
			id: `terminal-${terminalId}`,
		});

		// Terminal styles
		const terminalStyles = this.getTerminalStyles();
		const terminalStyle = tag("style", {
			textContent: terminalStyles,
		});
		document.body.appendChild(terminalStyle);

		// Create EditorFile for terminal
		const terminalFile = new EditorFile(terminalName, {
			type: "terminal",
			content: terminalContainer,
			tabIcon: "icon download",
			render: true,
		});

		// Wait for tab creation and setup
		const terminalInstance = await new Promise((resolve, reject) => {
			setTimeout(async () => {
				try {
					// Mount terminal component
					terminalComponent.mount(terminalContainer);

					// Write initial message
					terminalComponent.write("🚀 Installing Terminal Environment...\r\n");
					terminalComponent.write(
						"This may take a few minutes depending on your connection.\r\n\r\n",
					);

					// Setup event handlers
					this.setupTerminalHandlers(
						terminalFile,
						terminalComponent,
						terminalId,
					);

					const instance = {
						id: terminalId,
						name: terminalName,
						component: terminalComponent,
						file: terminalFile,
						container: terminalContainer,
					};

					this.terminals.set(terminalId, instance);
					resolve(instance);
				} catch (error) {
					console.error("Failed to create installation terminal:", error);
					reject(error);
				}
			}, 100);
		});

		return terminalInstance;
	}

	/**
	 * Setup terminal event handlers
	 * @param {EditorFile} terminalFile - Terminal file instance
	 * @param {TerminalComponent} terminalComponent - Terminal component
	 * @param {string} terminalId - Terminal ID
	 */
	setupTerminalHandlers(terminalFile, terminalComponent, terminalId) {
		// Handle tab focus/blur
		terminalFile.onfocus = () => {
			setTimeout(() => {
				terminalComponent.focus();
				terminalComponent.fit();
			}, 10);
		};

		// Handle tab close
		terminalFile.onclose = () => {
			this.closeTerminal(terminalId);
		};

		// Handle window resize
		const resizeObserver = new ResizeObserver(() => {
			setTimeout(() => {
				terminalComponent.fit();
			}, 100);
		});

		// Wait for the terminal container to be available, then observe it
		setTimeout(() => {
			const containerElement = terminalFile.content;
			if (containerElement && containerElement instanceof Element) {
				resizeObserver.observe(containerElement);
			} else {
				console.warn("Terminal container not available for ResizeObserver");
			}
		}, 200);

		// Terminal event handlers
		terminalComponent.onConnect = () => {
			console.log(`Terminal ${terminalId} connected`);
		};

		terminalComponent.onDisconnect = () => {
			console.log(`Terminal ${terminalId} disconnected`);
		};

		terminalComponent.onError = (error) => {
			console.error(`Terminal ${terminalId} error:`, error);
			window.toast?.("Terminal connection error");
			// Close the terminal tab on error
			this.closeTerminal(terminalId);
		};

		terminalComponent.onTitleChange = (title) => {
			if (title) {
				// Format terminal title as "Terminal ! - title"
				const formattedTitle = `Terminal ${this.terminalCounter} - ${title}`;
				terminalFile.filename = formattedTitle;
			}
		};

		// Store references for cleanup
		terminalFile._terminalId = terminalId;
		terminalFile.terminalComponent = terminalComponent;
		terminalFile._resizeObserver = resizeObserver;
	}

	/**
	 * Close a terminal session
	 * @param {string} terminalId - Terminal ID
	 */
	closeTerminal(terminalId) {
		const terminal = this.terminals.get(terminalId);
		if (!terminal) return;

		try {
			// Cleanup resize observer
			if (terminal.file._resizeObserver) {
				terminal.file._resizeObserver.disconnect();
			}

			// Dispose terminal component
			terminal.component.dispose();

			// Remove from map
			this.terminals.delete(terminalId);

			console.log(`Terminal ${terminalId} closed`);
		} catch (error) {
			console.error(`Error closing terminal ${terminalId}:`, error);
		}
	}

	/**
	 * Get terminal by ID
	 * @param {string} terminalId - Terminal ID
	 * @returns {object|null} Terminal instance
	 */
	getTerminal(terminalId) {
		return this.terminals.get(terminalId) || null;
	}

	/**
	 * Get all active terminals
	 * @returns {Map} All terminals
	 */
	getAllTerminals() {
		return this.terminals;
	}

	/**
	 * Write to a specific terminal
	 * @param {string} terminalId - Terminal ID
	 * @param {string} data - Data to write
	 */
	writeToTerminal(terminalId, data) {
		const terminal = this.getTerminal(terminalId);
		if (terminal) {
			terminal.component.write(data);
		}
	}

	/**
	 * Clear a specific terminal
	 * @param {string} terminalId - Terminal ID
	 */
	clearTerminal(terminalId) {
		const terminal = this.getTerminal(terminalId);
		if (terminal) {
			terminal.component.clear();
		}
	}

	/**
	 * Get terminal styles for shadow DOM
	 * @returns {string} CSS styles
	 */
	getTerminalStyles() {
		return `
			.terminal-content {
				width: 100%;
				height: 100%;
				box-sizing: border-box;
				background: #1e1e1e;
				overflow: hidden;
				position: relative;
			}
		`;
	}

	/**
	 * Create a local terminal (no server connection)
	 * @param {object} options - Terminal options
	 * @returns {Promise<object>} Terminal instance
	 */
	async createLocalTerminal(options = {}) {
		return this.createTerminal({
			...options,
			serverMode: false,
		});
	}

	/**
	 * Create a server terminal (with backend connection)
	 * @param {object} options - Terminal options
	 * @returns {Promise<object>} Terminal instance
	 */
	async createServerTerminal(options = {}) {
		return this.createTerminal({
			...options,
			serverMode: true,
		});
	}
}

// Create singleton instance
const terminalManager = new TerminalManager();

export default terminalManager;
