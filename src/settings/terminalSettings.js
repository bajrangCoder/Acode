import fsOperation from "fileSystem";
import settingsPage from "components/settingsPage";
import {
	DEFAULT_TERMINAL_SETTINGS,
	TerminalThemeManager,
} from "components/terminal";
import toast from "components/toast";
import alert from "dialogs/alert";
import confirm from "dialogs/confirm";
import loader from "dialogs/loader";
import fonts from "lib/fonts";
import appSettings from "lib/settings";
import FileBrowser from "pages/fileBrowser";
import helpers from "utils/helpers";

export default function terminalSettings() {
	const title = strings["terminal settings"];
	const values = appSettings.value;
	const categories = {
		permissions: strings["settings-category-permissions"],
		display: strings["settings-category-display"],
		cursor: strings["settings-category-cursor"],
		session: strings["settings-category-session"],
		maintenance: strings["settings-category-maintenance"],
	};

	// Initialize terminal settings with defaults if not present
	if (!values.terminalSettings) {
		values.terminalSettings = {
			...DEFAULT_TERMINAL_SETTINGS,
			fontFamily:
				DEFAULT_TERMINAL_SETTINGS.fontFamily || appSettings.value.fontFamily,
		};
	}

	const terminalValues = values.terminalSettings;
	const currentRenderEngine = terminalValues.renderEngine || "xtermjs";
	const isWtermRenderer = currentRenderEngine === "wterm";

	const items = [
		{
			key: "all_file_access",
			text: strings["allFileAccess"],
			info: strings["info-all_file_access"],
			category: categories.permissions,
			chevron: true,
		},
		{
			key: "renderEngine",
			text: strings["terminal:renderer"] || "Terminal Renderer",
			value: currentRenderEngine,
			select: [
				["xtermjs", "xterm.js"],
				["wterm", "wterm (Experimental)"],
			],
			info:
				strings["info-terminal-renderer"] ||
				"Choose the terminal renderer. wterm is experimental and uses DOM selection.",
			valueText(value) {
				const option = this.select.find(([v]) => v === value);
				return option ? option[1] : value;
			},
			category: categories.display,
		},
		...(isWtermRenderer
			? [
					{
						key: "wtermParser",
						text: strings["terminal:wterm parser"] || "wterm Parser",
						value: terminalValues.wtermParser || "default",
						select: [
							["default", "Default"],
							["ghostty", "Ghostty"],
						],
						info:
							strings["info-terminal-wterm-parser"] ||
							"Choose the parser core used by wterm.",
						valueText(value) {
							const option = this.select.find(([v]) => v === value);
							return option ? option[1] : value;
						},
						category: categories.display,
					},
				]
			: []),
		{
			key: "fontSize",
			text: strings["font size"],
			value: terminalValues.fontSize,
			prompt: strings["font size"],
			promptType: "number",
			promptOptions: {
				test(value) {
					value = Number.parseInt(value);
					return value >= 8 && value <= 32;
				},
			},
			info: strings["info-fontSize"],
			category: categories.display,
		},
		{
			key: "fontFamily",
			text: strings["terminal:font family"],
			value: terminalValues.fontFamily,
			get select() {
				return fonts.getNames();
			},
			info: strings["info-fontFamily"],
			category: categories.display,
		},
		{
			key: "theme",
			text: strings["theme"],
			value: terminalValues.theme,
			info: strings["info-theme"],
			get select() {
				return TerminalThemeManager.getThemeNames().map((name) => [
					name,
					name.charAt(0).toUpperCase() + name.slice(1),
				]);
			},
			valueText(value) {
				const option = this.select.find(([v]) => v === value);
				return option ? option[1] : value;
			},
			category: categories.display,
		},
		{
			key: "fontWeight",
			text: strings["terminal:font weight"],
			value: terminalValues.fontWeight,
			select: [
				"normal",
				"bold",
				"100",
				"200",
				"300",
				"400",
				"500",
				"600",
				"700",
				"800",
				"900",
			],
			info: strings["info-fontWeight"],
			category: categories.display,
		},
		{
			key: "letterSpacing",
			text: strings["letter spacing"],
			value: terminalValues.letterSpacing,
			prompt: strings["letter spacing"],
			promptType: "number",
			info: strings["info-letterSpacing"],
			category: categories.display,
			renderer: "xtermjs",
		},
		{
			key: "fontLigatures",
			text: strings["font ligatures"],
			checkbox: terminalValues.fontLigatures,
			info: strings["info-fontLigatures"],
			category: categories.display,
			renderer: "xtermjs",
		},
		{
			key: "cursorStyle",
			text: strings["terminal:cursor style"],
			value: terminalValues.cursorStyle,
			select: ["block", "underline", "bar"],
			info: strings["info-cursorStyle"],
			category: categories.cursor,
			renderer: "xtermjs",
		},
		{
			key: "cursorInactiveStyle",
			text: strings["terminal:cursor inactive style"],
			value: terminalValues.cursorInactiveStyle,
			select: ["outline", "block", "bar", "underline", "none"],
			info: strings["info-cursorInactiveStyle"],
			category: categories.cursor,
			renderer: "xtermjs",
		},
		{
			key: "cursorBlink",
			text: strings["terminal:cursor blink"],
			checkbox: terminalValues.cursorBlink,
			info: strings["info-cursorBlink"],
			category: categories.cursor,
		},
		{
			key: "scrollback",
			text: strings["terminal:scrollback"],
			value: terminalValues.scrollback,
			prompt: strings["terminal:scrollback"],
			promptType: "number",
			promptOptions: {
				test(value) {
					value = Number.parseInt(value);
					return value >= 100 && value <= 10000;
				},
			},
			info: strings["info-scrollback"],
			category: categories.session,
			renderer: "xtermjs",
		},
		{
			key: "tabStopWidth",
			text: strings["terminal:tab stop width"],
			value: terminalValues.tabStopWidth,
			prompt: strings["terminal:tab stop width"],
			promptType: "number",
			promptOptions: {
				test(value) {
					value = Number.parseInt(value);
					return value >= 1 && value <= 8;
				},
			},
			info: strings["info-tabStopWidth"],
			category: categories.session,
			renderer: "xtermjs",
		},
		{
			key: "convertEol",
			text: strings["terminal:convert eol"],
			checkbox: terminalValues.convertEol,
			info: strings["settings-info-terminal-convert-eol"],
			category: categories.session,
			renderer: "xtermjs",
		},
		{
			key: "imageSupport",
			text: strings["terminal:image support"],
			checkbox: terminalValues.imageSupport,
			info: strings["info-imageSupport"],
			category: categories.session,
			renderer: "xtermjs",
		},
		{
			key: "confirmTabClose",
			text: strings["terminal:confirm tab close"],
			checkbox: terminalValues.confirmTabClose !== false,
			info: strings["info-confirmTabClose"],
			category: categories.session,
		},
		{
			key: "failsafeMode",
			text: strings["terminal:failsafe"],
			checkbox: terminalValues.failsafeMode,
			info: strings["terminal:failsafe-info"],
			category: categories.maintenance,
		},
		{
			key: "backup",
			text: strings.backup,
			info: strings["info-backup"],
			category: categories.maintenance,
			chevron: true,
		},
		{
			key: "restore",
			text: strings.restore,
			info: strings["info-restore"],
			category: categories.maintenance,
			chevron: true,
		},
		{
			key: "uninstall",
			text: strings.uninstall,
			info: strings["info-uninstall"],
			category: categories.maintenance,
			chevron: true,
		},
	];

	const visibleItems = items.filter(
		(item) => !item.renderer || item.renderer === currentRenderEngine,
	);

	return settingsPage(title, visibleItems, callback, undefined, {
		preserveOrder: true,
		pageClassName: "detail-settings-page",
		listClassName: "detail-settings-list",
		infoAsDescription: true,
		valueInTail: true,
	});

	/**
	 * Callback for settings page when an item is clicked
	 * @param {string} key
	 * @param {string} value
	 */
	async function callback(key, value) {
		switch (key) {
			case "all_file_access":
				if (ANDROID_SDK_INT >= 30) {
					system.isManageExternalStorageDeclared((boolStr) => {
						if (boolStr === "true") {
							system.requestStorageManager(console.log, console.error);
						} else {
							alert(strings["feature not available"]);
						}
					}, alert);
				} else {
					alert(strings["feature not available"]);
				}

				return;
			case "backup":
				terminalBackup();
				return;

			case "restore":
				terminalRestore();
				return;

			case "uninstall":
				const confirmation = await confirm(
					strings.confirm,
					"Are you sure you want to uninstall the terminal?",
				);
				if (confirmation) {
					loader.showTitleLoader();
					Terminal.uninstall()
						.then(() => {
							loader.removeTitleLoader();
							alert(
								strings.success.toUpperCase(),
								"Terminal uninstalled successfully.",
							);
						})
						.catch((error) => {
							loader.removeTitleLoader();
							console.error("Terminal uninstall failed:", error);
							helpers.error(error);
						});
				}
				return;

			default:
				appSettings.update({
					terminalSettings: {
						...values.terminalSettings,
						[key]: value,
					},
				});

				// Update any active terminal instances
				if (key === "renderEngine" || key === "wtermParser") {
					toast(
						strings["terminal-renderer-reopen-info"] ||
							"New terminal renderer settings apply to newly opened terminals.",
					);
				} else {
					updateActiveTerminals(key, value);
				}
				break;
		}
	}

	/**
	 * Creates a backup of the terminal installation
	 */
	async function terminalBackup() {
		try {
			// Ask user to select backup location
			const { url } = await FileBrowser("folder", strings["select folder"]);

			loader.showTitleLoader();

			// Create backup
			const backupPath = await Terminal.backup();
			await system.copyToUri(
				backupPath,
				url,
				"aterm_backup.tar",
				console.log,
				console.error,
			);
			loader.removeTitleLoader();
			alert(strings.success.toUpperCase(), `${strings["backup successful"]}.`);
		} catch (error) {
			loader.removeTitleLoader();
			console.error("Terminal backup failed:", error);
			toast(error.toString());
		}
	}

	/**
	 * Restores terminal installation
	 */
	async function terminalRestore() {
		try {
			await Executor.execute("rm -rf $PREFIX/aterm_backup.*");

			sdcard.openDocumentFile(
				async (data) => {
					loader.showTitleLoader();
					//this will create a file at $PREFIX/atem_backup.tar.tar
					await system.copyToUri(
						data.uri,
						cordova.file.dataDirectory,
						"aterm_backup.tar",
						console.log,
						console.error,
					);

					// Restore
					await Terminal.restore();

					//Cleanup restore file
					await Executor.execute("rm -rf $PREFIX/aterm_backup.*");

					loader.removeTitleLoader();
					alert(
						strings.success.toUpperCase(),
						"Terminal restored successfully",
					);
				},
				toast,
				"application/x-tar",
			);
		} catch (error) {
			loader.removeTitleLoader();
			console.error("Terminal restore failed:", error);
			toast(error.toString());
		}
	}
}

/**
 * Update active terminal instances with new settings
 * @param {string} key
 * @param {any} value
 */
export async function updateActiveTerminals(key, value) {
	// Find all terminal tabs and update their settings
	const terminalTabs = editorManager.files.filter(
		(file) => file.type === "terminal",
	);

	terminalTabs.forEach(async (tab) => {
		if (tab.terminalComponent) {
			switch (key) {
				case "fontSize":
					tab.terminalComponent.updateOption("fontSize", value);
					break;
				case "fontFamily":
					// Load font if it's not already loaded
					try {
						fonts.injectFontFace(value);
						await fonts.loadFont(value);
					} catch (error) {
						console.warn(`Failed to load font ${value}:`, error);
					}
					tab.terminalComponent.updateOption("fontFamily", value);
					break;
				case "fontWeight":
					tab.terminalComponent.updateOption("fontWeight", value);
					break;
				case "cursorBlink":
					tab.terminalComponent.updateOption("cursorBlink", value);
					break;
				case "cursorStyle":
					tab.terminalComponent.updateOption("cursorStyle", value);
					break;
				case "cursorInactiveStyle":
					tab.terminalComponent.updateOption("cursorInactiveStyle", value);
					break;
				case "scrollback":
					tab.terminalComponent.updateOption("scrollback", value);
					break;
				case "tabStopWidth":
					tab.terminalComponent.updateOption("tabStopWidth", value);
					break;
				case "convertEol":
					tab.terminalComponent.updateOption("convertEol", value);
					break;
				case "letterSpacing":
					tab.terminalComponent.updateOption("letterSpacing", value);
					break;
				case "theme":
					tab.terminalComponent.updateOption("theme", value);
					// Update container background to match new theme
					if (tab.terminalComponent.container) {
						tab.terminalComponent.container.style.background =
							TerminalThemeManager.getTheme(value).background;
					}
					break;
				case "imageSupport":
					tab.terminalComponent.updateImageSupport(value);
					break;
				case "fontLigatures":
					tab.terminalComponent.updateFontLigatures(value);
					break;
			}
		}
	});
}
