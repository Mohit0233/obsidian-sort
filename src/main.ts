import {
	Plugin,
	TFolder,
	TAbstractFile,
	WorkspaceLeaf,
	PluginSettingTab,
	App,
	Setting,
} from "obsidian";

interface FolderSortSettings {
	sortOrder: "newest-first" | "oldest-first";
	enabled: boolean;
}

const DEFAULT_SETTINGS: FolderSortSettings = {
	sortOrder: "newest-first",
	enabled: true,
};

export default class FolderSortPlugin extends Plugin {
	settings: FolderSortSettings = DEFAULT_SETTINGS;
	private folderCtimeCache: Map<string, number> = new Map();
	private originalSortFunction: any = null;
	private patched = false;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new FolderSortSettingTab(this.app, this));

		this.addCommand({
			id: "refresh-folder-sort",
			name: "Refresh folder sort order",
			callback: () => this.refreshSort(),
		});

		this.addRibbonIcon("folder-clock", "Toggle folder sort by created date", () => {
			this.settings.enabled = !this.settings.enabled;
			this.saveSettings();
			this.refreshSort();
		});

		// Wait for layout to be ready before patching
		this.app.workspace.onLayoutReady(() => {
			this.cacheAllFolderCtimes().then(() => {
				this.patchFileExplorer();
			});
		});

		// Re-cache when folders are created/deleted/renamed
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFolder) {
					this.cacheFolderCtime(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder) {
					this.folderCtimeCache.delete(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFolder) {
					this.folderCtimeCache.delete(oldPath);
					this.cacheFolderCtime(file.path);
				}
			})
		);
	}

	onunload() {
		this.unpatchFileExplorer();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Fetch ctime for a single folder from the OS filesystem
	 */
	async cacheFolderCtime(path: string) {
		try {
			const stat = await this.app.vault.adapter.stat(path);
			if (stat && stat.type === "folder") {
				this.folderCtimeCache.set(path, stat.ctime);
			}
		} catch {
			// folder may not exist anymore
		}
	}

	/**
	 * Walk through all folders in the vault and cache their ctime
	 */
	async cacheAllFolderCtimes() {
		const allFolders = this.app.vault.getAllFolders(false);
		const promises = allFolders.map((folder) => this.cacheFolderCtime(folder.path));
		await Promise.all(promises);
	}

	/**
	 * Find the File Explorer leaf and its internal view
	 */
	private getFileExplorerView(): any | null {
		const leaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (leaves.length === 0) return null;
		return leaves[0].view;
	}

	/**
	 * Monkey-patch the File Explorer's sort function to sort folders by ctime
	 */
	private patchFileExplorer() {
		const fileExplorer = this.getFileExplorerView();
		if (!fileExplorer) return;

		// The file explorer has a `sortOrder` or uses `sort()` internally.
		// We need to intercept how children are sorted within each folder.
		// The internal API uses `fileExplorer.sort()` or the fileItems have a sort.
		// We'll monkey-patch the `sort` method on the file explorer.

		const plugin = this;

		// Access the internal sort function
		// In Obsidian's file explorer, sorting happens via the `sort` method on the view
		if (fileExplorer.sort && !this.patched) {
			this.originalSortFunction = fileExplorer.sort.bind(fileExplorer);

			fileExplorer.sort = function (this: any) {
				// Call original sort first (sorts files normally)
				plugin.originalSortFunction.call(this);

				if (!plugin.settings.enabled) return;

				// Now re-sort folders by ctime within each folder item
				plugin.sortFolderChildren(fileExplorer);
			};

			this.patched = true;

			// Trigger an initial sort
			this.refreshSort();
		} else {
			// Fallback: directly sort the folder items
			this.sortFolderChildren(fileExplorer);
		}
	}

	private unpatchFileExplorer() {
		if (this.originalSortFunction && this.patched) {
			const fileExplorer = this.getFileExplorerView();
			if (fileExplorer) {
				fileExplorer.sort = this.originalSortFunction;
			}
			this.patched = false;
		}
	}

	/**
	 * Core sorting logic: reorder folder DOM elements by ctime
	 */
	private sortFolderChildren(fileExplorer: any) {
		if (!this.settings.enabled) return;

		// fileExplorer.fileItems is a Record<string, FileItem>
		// Each FileItem has .file (TAbstractFile) and .el (HTMLElement)
		const fileItems = fileExplorer?.fileItems;
		if (!fileItems) return;

		// Group items by their parent folder
		const parentGroups = new Map<string, Array<{ path: string; item: any }>>();

		for (const [path, item] of Object.entries(fileItems) as [string, any][]) {
			const file = item.file;
			if (!(file instanceof TFolder)) continue;

			const parentPath = file.parent ? file.parent.path : "/";
			if (!parentGroups.has(parentPath)) {
				parentGroups.set(parentPath, []);
			}
			parentGroups.get(parentPath)!.push({ path, item });
		}

		// For each parent, sort its folder children by ctime and reorder DOM
		for (const [_parentPath, folderItems] of parentGroups) {
			if (folderItems.length < 2) continue;

			const multiplier = this.settings.sortOrder === "newest-first" ? -1 : 1;

			folderItems.sort((a, b) => {
				const ctimeA = this.folderCtimeCache.get(a.path) ?? 0;
				const ctimeB = this.folderCtimeCache.get(b.path) ?? 0;
				return (ctimeA - ctimeB) * multiplier;
			});

			// Reorder the DOM elements
			// Each item.el is a child inside the parent's children container
			const firstEl = folderItems[0].item.el;
			if (!firstEl) continue;
			const container = firstEl.parentElement;
			if (!container) continue;

			// Collect all non-folder elements to preserve their positions
			// We only reorder folder elements among themselves
			const allChildren = Array.from(container.children) as HTMLElement[];
			const folderEls = new Set(folderItems.map((fi) => fi.item.el));

			// Find positions where folders currently are
			const folderPositions: number[] = [];
			allChildren.forEach((child, idx) => {
				if (folderEls.has(child)) {
					folderPositions.push(idx);
				}
			});

			// Place sorted folders into those positions
			const newChildren = [...allChildren];
			folderItems.forEach((fi, i) => {
				if (i < folderPositions.length) {
					newChildren[folderPositions[i]] = fi.item.el;
				}
			});

			// Re-append in new order
			for (const child of newChildren) {
				container.appendChild(child);
			}
		}
	}

	/**
	 * Refresh sort - re-cache and re-sort
	 */
	async refreshSort() {
		await this.cacheAllFolderCtimes();
		const fileExplorer = this.getFileExplorerView();
		if (fileExplorer) {
			if (this.patched && fileExplorer.sort) {
				fileExplorer.sort();
			} else {
				this.sortFolderChildren(fileExplorer);
			}
		}
	}
}

class FolderSortSettingTab extends PluginSettingTab {
	plugin: FolderSortPlugin;

	constructor(app: App, plugin: FolderSortPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Folder Sort by Created Date" });

		new Setting(containerEl)
			.setName("Enable folder sorting")
			.setDesc("Sort folders in File Explorer by their OS creation date")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					this.plugin.refreshSort();
				})
			);

		new Setting(containerEl)
			.setName("Sort order")
			.setDesc("Choose whether newest or oldest folders appear first")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("newest-first", "Newest first")
					.addOption("oldest-first", "Oldest first")
					.setValue(this.plugin.settings.sortOrder)
					.onChange(async (value) => {
						this.plugin.settings.sortOrder = value as "newest-first" | "oldest-first";
						await this.plugin.saveSettings();
						this.plugin.refreshSort();
					})
			);

		containerEl.createEl("h3", { text: "Debug Info" });

		const debugBtn = new Setting(containerEl)
			.setName("Show cached folder dates")
			.setDesc("View the creation dates the plugin has read from the OS")
			.addButton((btn) =>
				btn.setButtonText("Show").onClick(async () => {
					await this.plugin.refreshSort();
					const debugEl = containerEl.createEl("pre", {
						cls: "folder-sort-debug",
					});
					const entries = Array.from(
						(this.plugin as any).folderCtimeCache.entries()
					).sort((a: any, b: any) => a[1] - b[1]);

					const lines = entries.map(([path, ctime]: [string, number]) => {
						const date = new Date(ctime);
						return `${date.toISOString().slice(0, 19)}  ${path}`;
					});
					debugEl.textContent = lines.join("\n");
				})
			);
	}
}
