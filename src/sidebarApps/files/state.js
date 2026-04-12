import appSettings from "lib/settings";

export const SIDEBAR_FILE_TREE_SORT_NAME_ASC = "name-asc";
export const SIDEBAR_FILE_TREE_SORT_NAME_DESC = "name-desc";
export const SIDEBAR_FILE_TREE_SORT_MODIFIED_DESC = "modified-desc";
export const SIDEBAR_FILE_TREE_SORT_MODIFIED_ASC = "modified-asc";
export const SIDEBAR_FILE_TREE_SORT_SIZE_DESC = "size-desc";
export const SIDEBAR_FILE_TREE_SORT_SIZE_ASC = "size-asc";

const listeners = new Set();
let searchQuery = "";
let initialized = false;

export function isMetadataSortMode(value) {
	return [
		SIDEBAR_FILE_TREE_SORT_MODIFIED_DESC,
		SIDEBAR_FILE_TREE_SORT_MODIFIED_ASC,
		SIDEBAR_FILE_TREE_SORT_SIZE_DESC,
		SIDEBAR_FILE_TREE_SORT_SIZE_ASC,
	].includes(value);
}

export function getSidebarFilesState() {
	return {
		searchQuery,
		showControls: appSettings.value.showSidebarFileTreeControls !== false,
		showHiddenFiles: !!appSettings.value.fileBrowser.showHiddenFiles,
		sortMode:
			appSettings.value.sidebarFileTreeSortMode ||
			SIDEBAR_FILE_TREE_SORT_NAME_ASC,
	};
}

export function onSidebarFilesStateChange(callback) {
	if (typeof callback !== "function") return () => {};
	init();
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}

export function setSidebarFilesSearchQuery(value) {
	const nextQuery = String(value || "").trim();
	if (nextQuery === searchQuery) return;
	searchQuery = nextQuery;
	emit();
}

export async function setSidebarFileTreeSortMode(value) {
	if (
		value !== SIDEBAR_FILE_TREE_SORT_NAME_ASC &&
		value !== SIDEBAR_FILE_TREE_SORT_NAME_DESC &&
		value !== SIDEBAR_FILE_TREE_SORT_MODIFIED_DESC &&
		value !== SIDEBAR_FILE_TREE_SORT_MODIFIED_ASC &&
		value !== SIDEBAR_FILE_TREE_SORT_SIZE_DESC &&
		value !== SIDEBAR_FILE_TREE_SORT_SIZE_ASC
	) {
		return;
	}

	if (appSettings.value.sidebarFileTreeSortMode === value) return;
	appSettings.value.sidebarFileTreeSortMode = value;
	await appSettings.update(false);
}

export async function setSidebarHiddenFilesVisible(visible) {
	const nextValue = !!visible;
	if (appSettings.value.fileBrowser.showHiddenFiles === nextValue) return;
	appSettings.value.fileBrowser.showHiddenFiles = nextValue;
	await appSettings.update(false);
}

export async function setSidebarFileTreeControlsVisible(visible) {
	const nextValue = !!visible;
	if (appSettings.value.showSidebarFileTreeControls === nextValue) return;
	appSettings.value.showSidebarFileTreeControls = nextValue;
	await appSettings.update(false);
}

function init() {
	if (initialized) return;
	initialized = true;
	appSettings.on("update:fileBrowser", emit);
	appSettings.on("update:showSidebarFileTreeControls", emit);
	appSettings.on("update:sidebarFileTreeSortMode", emit);
}

function emit() {
	const state = getSidebarFilesState();
	listeners.forEach((listener) => listener(state));
}
