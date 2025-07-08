import appSettings from "lib/settings";

export const DEFAULT_TERMINAL_SETTINGS = {
	fontSize: 14,
	fontFamily: "MesloLGS NF Regular",
	fontWeight: "normal",
	cursorBlink: true,
	cursorStyle: "block",
	cursorInactiveStyle: "underline",
	scrollback: 1000,
	theme: "dark",
	tabStopWidth: 4,
	convertEol: true,
	letterSpacing: 0,
	imageSupport: false,
	fontLigatures: false,
};

export function getTerminalSettings() {
	const settings = appSettings.value.terminalSettings || {};
	return {
		...DEFAULT_TERMINAL_SETTINGS,
		...settings,
	};
}
