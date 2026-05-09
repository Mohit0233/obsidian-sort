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
	sortOrder: "oldest-first",
	enabled: true,
};

export default class FolderSortPlugin extends Plugin {
	settings: FolderSortSettings = DEFAULT_SETTINGS;
	folderCtimeCache: Map<string, number> = new Map();
	private originalGetSortedFolderItems: any = null;
	patched = false;

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

		this.app.workspace.onLayoutReady(() => {
			this.cacheAllFolderCtimes().then(() => {
				this.patchFileExplorer();
			});
		});

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFolder) {
					this.cacheFolderCtime(file.path).then(() => this.triggerSort());
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder) {
					this.folderCtimeCache.delete(file.path);
					this.triggerSort();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFolder) {
					this.folderCtimeCache.delete(oldPath);
					this.cacheFolderCtime(file.path).then(() => this.triggerSort());
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

	async cacheAllFolderCtimes() {
		const allFolders = this.app.vault.getAllFolders(false);
		await Promise.all(allFolders.map((folder) => this.cacheFolderCtime(folder.path)));
	}

	private getFileExplorerView(): any | null {
		const leaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (leaves.length === 0) return null;
		return leaves[0].view;
	}

	/**
	 * Override getSortedFolderItems to sort folders by OS ctime.
	 *
	 * Obsidian's default getSortedFolderItems sorts folders alphabetically
	 * regardless of sort order. We intercept this to re-sort the folder
	 * portion of the returned array by cached ctime.
	 */
	private patchFileExplorer() {
		const fileExplorer = this.getFileExplorerView();
		if (!fileExplorer || this.patched) return;

		const plugin = this;
		this.originalGetSortedFolderItems = fileExplorer.getSortedFolderItems.bind(fileExplorer);

		fileExplorer.getSortedFolderItems = function (folder: any) {
			// Call original to get the default sorted list
			const items: any[] = plugin.originalGetSortedFolderItems(folder);

			if (!plugin.settings.enabled) return items;

			// Separate folders and files while preserving relative order:
			// Obsidian puts all folders first, then files.
			const folderItems: any[] = [];
			const fileItems: any[] = [];
			let lastFolderIdx = -1;

			for (let i = 0; i < items.length; i++) {
				if (items[i].file instanceof TFolder) {
					folderItems.push(items[i]);
					lastFolderIdx = i;
				} else {
					fileItems.push(items[i]);
				}
			}

			if (folderItems.length < 2) return items;

			const multiplier = plugin.settings.sortOrder === "newest-first" ? -1 : 1;

			folderItems.sort((a, b) => {
				const ctimeA = plugin.folderCtimeCache.get(a.file.path) ?? 0;
				const ctimeB = plugin.folderCtimeCache.get(b.file.path) ?? 0;
				return (ctimeA - ctimeB) * multiplier;
			});

			// Reconstruct: sorted folders first, then files in original order
			return [...folderItems, ...fileItems];
		};

		this.patched = true;
		this.triggerSort();
	}

	private unpatchFileExplorer() {
		if (this.originalGetSortedFolderItems && this.patched) {
			const fileExplorer = this.getFileExplorerView();
			if (fileExplorer) {
				fileExplorer.getSortedFolderItems = this.originalGetSortedFolderItems;
				this.triggerSort();
			}
			this.patched = false;
		}
	}

	private triggerSort() {
		const fileExplorer = this.getFileExplorerView();
		if (fileExplorer?.sort) {
			fileExplorer.sort();
		}
	}

	async refreshSort() {
		await this.cacheAllFolderCtimes();
		this.triggerSort();
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
