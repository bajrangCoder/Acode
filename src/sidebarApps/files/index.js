import "./style.scss";
import Sidebar from "components/sidebar";
import select from "dialogs/select";
import settings from "lib/settings";
import {
	getSidebarFilesState,
	onSidebarFilesStateChange,
	SIDEBAR_FILE_TREE_SORT_MODIFIED_ASC,
	SIDEBAR_FILE_TREE_SORT_MODIFIED_DESC,
	SIDEBAR_FILE_TREE_SORT_NAME_ASC,
	SIDEBAR_FILE_TREE_SORT_NAME_DESC,
	SIDEBAR_FILE_TREE_SORT_SIZE_ASC,
	SIDEBAR_FILE_TREE_SORT_SIZE_DESC,
	setSidebarFilesSearchQuery,
	setSidebarFileTreeControlsVisible,
	setSidebarFileTreeSortMode,
	setSidebarHiddenFilesVisible,
} from "./state";

/**@type {HTMLElement} */
let container;
/**@type {HTMLElement} */
let listArea;
/**@type {HTMLElement} */
let toolbar;
/**@type {HTMLElement} */
let toolbarTitle;
/**@type {HTMLButtonElement} */
let searchButton;
/**@type {HTMLButtonElement} */
let filterButton;
/**@type {HTMLButtonElement} */
let moreButton;
/**@type {HTMLElement} */
let searchPanel;
/**@type {HTMLInputElement} */
let searchInput;
/**@type {HTMLButtonElement} */
let clearSearchButton;

let appliedState;
let stateRunId = 0;
let isSearchOpen = false;

export default [
	"documents", // icon
	"files", // id
	strings["files"], // title
	initApp, // init function
	false, // prepend
	onSelected, // onSelected function
];

/**
 * Initialize files app
 * @param {HTMLElement} el
 */
function initApp(el) {
	container = el;
	container.classList.add("files");
	listArea = (
		<div
			className="files-list-area scroll"
			data-msg={strings["open folder"]}
		></div>
	);
	toolbar = (
		<section className="files-toolbar">
			<div className="files-toolbar-shell">
				<div className="files-toolbar-title-wrap">
					<span className="icon folder"></span>
					<span className="files-toolbar-title">{strings.files}</span>
				</div>

				<div className="files-toolbar-actions">
					<button
						className="files-toolbar-action icon-button"
						type="button"
						title={strings.search}
						aria-label={strings.search}
						data-role="search"
					>
						<span className="icon search"></span>
					</button>
					<button
						className="files-toolbar-action icon-button"
						type="button"
						title={strings.sort || "Sort"}
						aria-label={strings.sort || "Sort"}
						data-role="filter"
					>
						<span className="icon funnel"></span>
					</button>
					<button
						className="files-toolbar-action icon-button"
						type="button"
						title={strings.more || "More"}
						aria-label={strings.more || "More"}
						data-role="more"
					>
						<span className="icon more_vert"></span>
					</button>
				</div>
			</div>

			<div className="files-toolbar-panel">
				<label className="files-toolbar-search">
					<span className="icon search"></span>
					<input
						type="search"
						placeholder={
							strings["search files"] ||
							(strings.search ? `${strings.search} files` : "Search files")
						}
						enterKeyHint="search"
					/>
					<button
						className="files-toolbar-clear"
						type="button"
						title={strings.close || strings.clear || "Close"}
						aria-label={strings.close || strings.clear || "Close"}
					>
						<span className="icon clearclose"></span>
					</button>
				</label>
			</div>
		</section>
	);

	container.append(toolbar, listArea);
	container.$listArea = listArea;

	toolbarTitle = toolbar.querySelector(".files-toolbar-title");
	searchButton = toolbar.querySelector('[data-role="search"]');
	filterButton = toolbar.querySelector('[data-role="filter"]');
	moreButton = toolbar.querySelector('[data-role="more"]');
	searchPanel = toolbar.querySelector(".files-toolbar-panel");
	searchInput = toolbar.querySelector('input[type="search"]');
	clearSearchButton = toolbar.querySelector(".files-toolbar-clear");

	container.addEventListener("click", clickHandler);
	searchButton.addEventListener("click", onSearchToggle);
	filterButton.addEventListener("click", openSortMenu);
	moreButton.addEventListener("click", openMoreMenu);
	searchInput.addEventListener("input", onSearchInput);
	searchInput.addEventListener("keydown", onSearchKeydown);
	clearSearchButton.addEventListener("click", closeSearch);

	editorManager.on(
		["new-file", "int-open-file-list", "remove-file"],
		(position) => {
			if (
				typeof position === "string" &&
				position !== settings.OPEN_FILE_LIST_POS_SIDEBAR
			) {
				return;
			}

			const fileList = getRootLists().find((list) =>
				list.classList.contains("file-list"),
			);
			if (fileList) fixHeight(fileList);
			syncToolbar(getSidebarFilesState());
		},
	);
	editorManager.on("add-folder", onFolderMutation);
	editorManager.on("remove-folder", onFolderMutation);
	editorManager.on("sidebar-files-tree-update", onFolderMutation);
	Sidebar.on("show", onSelected);
	onSidebarFilesStateChange(handleSidebarStateChange);
	handleSidebarStateChange(getSidebarFilesState());
}

/**
 * On selected handler for files app
 * @param {HTMLElement} el
 */
function onSelected(el) {
	const $scrollableLists = container.getAll(":scope .scroll[data-scroll-top]");
	$scrollableLists.forEach(($el) => {
		$el.scrollTop = $el.dataset.scrollTop;
	});
}

/**
 * Click handler for files app
 * @param {MouseEvent} e
 * @returns
 */
function clickHandler(e) {
	const { target } = e;
	if (!(target instanceof HTMLElement)) return;

	if (!getRootLists().length && !target.closest(".files-toolbar")) {
		acode.exec("open-folder");
		return;
	}

	const $rootTile = target.closest(".files-list-area > .list > .tile");
	if ($rootTile) {
		fixHeight($rootTile.parentElement);
		queueMicrotask(() => {
			const state = getSidebarFilesState();
			if (!hasLoadedRootTree() && state.searchQuery) {
				closeSearch();
				return;
			}
			syncToolbar(state);
		});
	}
}

/**
 * Update list height
 * @param {HTMLElement} target Target element
 */
export function fixHeight(target) {
	const lists = getVisibleLists();
	const ITEM_HEIGHT = 30;
	if (!lists.length) return;

	target =
		target && lists.includes(target)
			? target
			: lists.find((list) => list.unclasped) || lists[0];

	let height = (lists.length - 1) * ITEM_HEIGHT;
	let activeFileList;

	if (settings.value.openFileListPos === settings.OPEN_FILE_LIST_POS_SIDEBAR) {
		const [firstList] = lists;
		if (firstList?.classList.contains("file-list")) {
			activeFileList = firstList;
			if (firstList.unclasped) {
				const heightOffset = height - ITEM_HEIGHT;
				const totalHeight =
					ITEM_HEIGHT * activeFileList.$ul.children.length + ITEM_HEIGHT;
				const maxHeight =
					lists.length === 1 || !lists.slice(1).find((list) => list.unclasped)
						? window.innerHeight
						: window.innerHeight / 2;
				const minHeight = Math.min(totalHeight, maxHeight - heightOffset);

				activeFileList.style.maxHeight = `${minHeight}px`;
				activeFileList.style.height = `${minHeight}px`;
				height += minHeight - ITEM_HEIGHT;
			}
		}
	}

	lists.forEach((list) => {
		if (list === activeFileList) return;

		if (target === activeFileList) {
			if (list.collapsed) {
				list.style.removeProperty("max-height");
				list.style.removeProperty("height");
				return;
			}
			target = list;
		}

		if (list === target && target.unclasped) {
			list.style.maxHeight = `calc(100% - ${height}px)`;
			list.style.height = `calc(100% - ${height}px)`;
			return;
		}

		if (list.collapsed) {
			list.style.removeProperty("max-height");
			list.style.removeProperty("height");
			return;
		}

		list.collapse();
		list.style.removeProperty("max-height");
		list.style.removeProperty("height");
	});
}

function getRootLists() {
	if (!listArea) return [];
	return Array.from(listArea.children).filter((child) =>
		child.classList?.contains("list"),
	);
}

function getRootFolderLists() {
	return getRootLists().filter((list) => !list.classList.contains("file-list"));
}

function getVisibleLists() {
	return getRootLists().filter((list) => !list.hidden);
}

function getLoadedRootTrees() {
	return getRootFolderLists()
		.map((list) => list.$ul?._fileTree)
		.filter(Boolean);
}

function hasLoadedRootTree() {
	return getLoadedRootTrees().length > 0;
}

function onFolderMutation() {
	const state = getSidebarFilesState();
	if (!hasLoadedRootTree() && state.searchQuery) {
		closeSearch();
		return;
	}

	applyRootFilter(state.searchQuery);
	syncToolbar(state);
	fixHeight();
}

function onSearchInput(e) {
	setSidebarFilesSearchQuery(e.target.value);
}

function onSearchKeydown(e) {
	if (e.key !== "Escape") return;
	e.preventDefault();
	closeSearch();
}

function onSearchToggle() {
	if (!hasLoadedRootTree()) return;

	isSearchOpen = !isSearchOpen;
	if (!isSearchOpen && !getSidebarFilesState().searchQuery) {
		syncToolbar(getSidebarFilesState());
		return;
	}

	syncToolbar(getSidebarFilesState());
	if (isSearchOpen) {
		queueMicrotask(() => searchInput?.focus());
	}
}

function closeSearch() {
	isSearchOpen = false;
	if (searchInput) searchInput.value = "";
	setSidebarFilesSearchQuery("");
	syncToolbar(getSidebarFilesState());
}

async function openSortMenu() {
	if (!hasLoadedRootTree()) return;

	const state = getSidebarFilesState();
	try {
		const value = await select(strings.sort || "Sort", getSortItems(), {
			default: state.sortMode,
			rejectOnCancel: true,
		});
		if (!value || value === state.sortMode) return;
		await setSidebarFileTreeSortMode(value);
	} catch (error) {
		// ignore cancel
	}
}

async function openMoreMenu() {
	const state = getSidebarFilesState();
	try {
		const action = await select(
			strings.more || "More",
			getMoreItems(state),
			true,
		);
		if (!action) return;

		switch (action) {
			case "reload":
				if (!hasLoadedRootTree()) return;
				await reloadLoadedTrees();
				return;

			case "toggle-hidden":
				await setSidebarHiddenFilesVisible(!state.showHiddenFiles);
				return;

			case "collapse-all":
				if (!getRootFolderLists().some((list) => list.unclasped)) return;
				collapseAllLists();
				return;

			case "disable-toolbar":
				closeSearch();
				await setSidebarFileTreeControlsVisible(false);
				return;

			default:
				return;
		}
	} catch (error) {
		// ignore cancel
	}
}

async function reloadLoadedTrees() {
	const state = getSidebarFilesState();
	if (!hasLoadedRootTree()) return;

	await withToolbarBusy(async () => {
		await Promise.allSettled(
			getLoadedRootTrees().map(async (fileTree) => {
				fileTree.updateDisplayOptions(state);
				fileTree.setSearchQuery(state.searchQuery);
				await fileTree.refresh();
			}),
		);
	});

	applyRootFilter(state.searchQuery);
	syncToolbar(state);
	fixHeight();
}

function collapseAllLists() {
	getRootFolderLists().forEach((list) => {
		if (list.unclasped) list.collapse();
	});

	closeSearch();
	fixHeight();
}

async function handleSidebarStateChange(state) {
	const currentRunId = ++stateRunId;
	if (!state.showControls && state.searchQuery) {
		closeSearch();
		return;
	}

	const shouldRefreshTrees =
		!appliedState ||
		appliedState.sortMode !== state.sortMode ||
		appliedState.showHiddenFiles !== state.showHiddenFiles;
	const shouldFilterTrees =
		!shouldRefreshTrees &&
		(!appliedState || appliedState.searchQuery !== state.searchQuery);

	appliedState = { ...state };

	if (shouldRefreshTrees) {
		await withToolbarBusy(async () => {
			await Promise.allSettled(
				getLoadedRootTrees().map(async (fileTree) => {
					fileTree.updateDisplayOptions(state);
					fileTree.setSearchQuery(state.searchQuery);
					await fileTree.refresh();
				}),
			);
		});
	} else if (shouldFilterTrees) {
		getLoadedRootTrees().forEach((fileTree) => {
			fileTree.setSearchQuery(state.searchQuery);
		});
	}

	if (currentRunId !== stateRunId) return;

	applyRootFilter(state.searchQuery);
	syncToolbar(state);
	fixHeight();
}

function applyRootFilter(query) {
	const normalizedQuery = String(query || "")
		.trim()
		.toLowerCase();

	getRootLists().forEach((list) => {
		if (list.classList.contains("file-list")) {
			applyOpenFileListFilter(list, normalizedQuery);
			return;
		}

		const title = list.$title?.dataset?.name || "";
		const ownMatch =
			!normalizedQuery || title.toLowerCase().includes(normalizedQuery);
		const fileTree = list.$ul?._fileTree;
		const hasTreeMatch = !!fileTree?.hasVisibleEntries();
		list.hidden = normalizedQuery ? !(ownMatch || hasTreeMatch) : false;
	});
}

function applyOpenFileListFilter(list, query) {
	const items = Array.from(list.$ul?.children || []);
	let visibleItems = 0;

	items.forEach((item) => {
		const label = item.textContent?.toLowerCase() || "";
		const isVisible = !query || label.includes(query);
		item.hidden = !isVisible;
		if (isVisible) visibleItems += 1;
	});

	const title = list.$title?.textContent?.toLowerCase() || "";
	list.hidden = query ? !(title.includes(query) || visibleItems > 0) : false;
}

function syncToolbar(state) {
	const rootLists = getRootFolderLists();
	const loadedTree = hasLoadedRootTree();
	const expandedRoot = rootLists.find((list) => list.unclasped && !list.hidden);
	const firstRoot =
		expandedRoot || rootLists.find((list) => !list.hidden) || rootLists[0];
	const rootName = firstRoot?.$title?.dataset?.name || strings.files;
	const searchVisible =
		state.showControls && loadedTree && (isSearchOpen || !!state.searchQuery);

	if (!loadedTree && !state.searchQuery) {
		isSearchOpen = false;
	}

	toolbar.hidden = !state.showControls || !getRootLists().length;
	toolbar.classList.toggle("has-search", searchVisible);

	toolbarTitle.textContent = rootName;

	searchButton.hidden = !loadedTree;
	filterButton.hidden = !loadedTree;
	searchButton.disabled = !loadedTree;
	filterButton.disabled = !loadedTree;
	moreButton.hidden = !rootLists.length;
	moreButton.disabled = !rootLists.length;

	searchButton.classList.toggle("is-active", searchVisible);
	filterButton.classList.remove("is-active");

	searchPanel.setAttribute("aria-hidden", String(!searchVisible));
	searchInput.value = state.searchQuery;
	clearSearchButton.hidden = !state.searchQuery;
}

function getSortItems() {
	return [
		{
			value: SIDEBAR_FILE_TREE_SORT_NAME_ASC,
			text: `${strings["sort by name"] || "Sort by name"} · A-Z`,
		},
		{
			value: SIDEBAR_FILE_TREE_SORT_NAME_DESC,
			text: `${strings["sort by name"] || "Sort by name"} · Z-A`,
		},
		{
			value: SIDEBAR_FILE_TREE_SORT_MODIFIED_DESC,
			text: strings["sort by latest"] || "Sort by latest",
		},
		{
			value: SIDEBAR_FILE_TREE_SORT_MODIFIED_ASC,
			text: strings["sort by oldest"] || "Sort by oldest",
		},
		{
			value: SIDEBAR_FILE_TREE_SORT_SIZE_DESC,
			text: strings["sort by size"] || "Sort by size · largest",
		},
		{
			value: SIDEBAR_FILE_TREE_SORT_SIZE_ASC,
			text: strings["sort by small size"] || "Sort by size · smallest",
		},
	];
}

function getMoreItems(state) {
	return [
		{
			value: "reload",
			text: strings.reload || "Reload",
			icon: "refresh",
			disabled: !hasLoadedRootTree(),
		},
		{
			value: "toggle-hidden",
			text: state.showHiddenFiles
				? strings["hide hidden files"] || "Hide hidden files"
				: strings["show hidden files"] || "Show hidden files",
			icon: state.showHiddenFiles
				? "visibility_off"
				: "remove_red_eyevisibility",
			checkbox: state.showHiddenFiles,
		},
		{
			value: "collapse-all",
			text: strings["collapse all"] || "Collapse all",
			icon: "unfold_less",
			disabled: !getRootFolderLists().some((list) => list.unclasped),
		},
		{
			value: "disable-toolbar",
			text: strings["disable toolbar"] || "Disable toolbar",
			icon: "fullscreen_exit",
		},
	];
}

async function withToolbarBusy(callback) {
	toolbar.classList.add("is-busy");
	try {
		await callback();
	} finally {
		toolbar.classList.remove("is-busy");
	}
}
