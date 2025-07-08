import settingsPage from "components/settingsPage";
import {
	DEFAULT_TERMINAL_SETTINGS,
	TerminalThemeManager,
} from "components/terminal";
import fonts from "lib/fonts";
import appSettings from "lib/settings";

export default function terminalSettings() {
	const title = "Terminal Settings";
	const values = appSettings.value;

	// Initialize terminal settings with defaults if not present
	if (!values.terminalSettings) {
		values.terminalSettings = {
			...DEFAULT_TERMINAL_SETTINGS,
			fontFamily:
				DEFAULT_TERMINAL_SETTINGS.fontFamily || appSettings.value.fontFamily,
		};
	}

	const terminalValues = values.terminalSettings;

	const items = [
		{
			key: "fontSize",
			text: "Font Size",
			value: terminalValues.fontSize,
			prompt: "Font Size",
			promptType: "number",
			promptOptions: {
				test(value) {
					value = Number.parseInt(value);
					return value >= 8 && value <= 32;
				},
			},
		},
		{
			key: "fontFamily",
			text: "Font Family",
			value: terminalValues.fontFamily,
			get select() {
				return fonts.getNames();
			},
		},
		{
			key: "theme",
			text: "Theme",
			value: terminalValues.theme,
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
		},
		{
			key: "cursorStyle",
			text: "Cursor Style",
			value: terminalValues.cursorStyle,
			select: ["block", "underline", "bar"],
		},
		{
			key: "cursorInactiveStyle",
			text: "Cursor Inactive Style",
			value: terminalValues.cursorInactiveStyle,
			select: ["outline", "block", "bar", "underline", "none"],
		},
		{
			key: "fontWeight",
			text: "Font Weight",
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
		},
		{
			key: "cursorBlink",
			text: "Cursor Blink",
			checkbox: terminalValues.cursorBlink,
		},
		{
			key: "scrollback",
			text: "Scrollback Lines",
			value: terminalValues.scrollback,
			prompt: "Scrollback Lines",
			promptType: "number",
			promptOptions: {
				test(value) {
					value = Number.parseInt(value);
					return value >= 100 && value <= 10000;
				},
			},
		},
		{
			key: "tabStopWidth",
			text: "Tab Stop Width",
			value: terminalValues.tabStopWidth,
			prompt: "Tab Stop Width",
			promptType: "number",
			promptOptions: {
				test(value) {
					value = Number.parseInt(value);
					return value >= 1 && value <= 8;
				},
			},
		},
		{
			key: "letterSpacing",
			text: "Letter Spacing",
			value: terminalValues.letterSpacing,
			prompt: "Letter Spacing",
			promptType: "number",
		},
		{
			key: "convertEol",
			text: "Convert EOL",
			checkbox: terminalValues.convertEol,
		},
		{
			key: "imageSupport",
			text: "Image Support",
			checkbox: terminalValues.imageSupport,
		},
		{
			key: "fontLigatures",
			text: "Font Ligatures",
			checkbox: terminalValues.fontLigatures,
		},
	];

	return settingsPage(title, items, callback);

	/**
	 * Callback for settings page when an item is clicked
	 * @param {string} key
	 * @param {string} value
	 */
	function callback(key, value) {
		appSettings.update({
			terminalSettings: {
				...values.terminalSettings,
				[key]: value,
			},
		});

		// Update any active terminal instances
		updateActiveTerminals(key, value);
	}
}

/**
 * Update active terminal instances with new settings
 * @param {string} key
 * @param {any} value
 */
async function updateActiveTerminals(key, value) {
	// Find all terminal tabs and update their settings
	const terminalTabs = editorManager.files.filter(
		(file) => file.type === "terminal",
	);

	terminalTabs.forEach(async (tab) => {
		if (tab.terminalComponent) {
			const terminalOptions = {};

			switch (key) {
				case "fontSize":
					tab.terminalComponent.terminal.options.fontSize = value;
					break;
				case "fontFamily":
					// Load font if it's not already loaded
					try {
						await fonts.loadFont(value);
					} catch (error) {
						console.warn(`Failed to load font ${value}:`, error);
					}
					tab.terminalComponent.terminal.options.fontFamily = value;
					tab.terminalComponent.terminal.refresh(
						0,
						tab.terminalComponent.terminal.rows - 1,
					);
					break;
				case "fontWeight":
					tab.terminalComponent.terminal.options.fontWeight = value;
					break;
				case "cursorBlink":
					tab.terminalComponent.terminal.options.cursorBlink = value;
					break;
				case "cursorStyle":
					tab.terminalComponent.terminal.options.cursorStyle = value;
					break;
				case "cursorInactiveStyle":
					tab.terminalComponent.terminal.options.cursorInactiveStyle = value;
					break;
				case "scrollback":
					tab.terminalComponent.terminal.options.scrollback = value;
					break;
				case "tabStopWidth":
					tab.terminalComponent.terminal.options.tabStopWidth = value;
					break;
				case "convertEol":
					tab.terminalComponent.terminal.options.convertEol = value;
					break;
				case "letterSpacing":
					tab.terminalComponent.terminal.options.letterSpacing = value;
					break;
				case "theme":
					tab.terminalComponent.terminal.options.theme =
						TerminalThemeManager.getTheme(value);
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
