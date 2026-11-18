import { App, ButtonComponent, Modal, Notice, setIcon, TFile } from "obsidian";

const MAX_RESULTS = 100;

/** Search and multi-select Markdown notes for one chat's persistent context. */
export class ContextNotesModal extends Modal {
	private selected: Set<string>;
	private searchEl!: HTMLInputElement;
	private selectedEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private saving = false;

	constructor(
		app: App,
		private initialPaths: string[],
		private onSave: (paths: string[], saveAsDefault: boolean) => Promise<void>,
	) {
		super(app);
		this.selected = new Set(initialPaths);
	}

	override onOpen(): void {
		this.setTitle("Context notes for this chat");
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			cls: "brainiac-wizard-context-description",
			text: "Choose Markdown notes to include with each message in this chat. Changes here do not affect other chats.",
		});
		this.searchEl = this.contentEl.createEl("input", {
			cls: "brainiac-wizard-context-search",
			attr: { type: "search", placeholder: "Search notes by title or path…", "aria-label": "Search notes by title or path" },
		});
		this.searchEl.addEventListener("input", () => this.renderResults());
		this.selectedEl = this.contentEl.createDiv({ cls: "brainiac-wizard-context-selected" });
		this.resultsEl = this.contentEl.createDiv({ cls: "brainiac-wizard-context-results" });
		this.renderSelected();
		this.renderResults();

		const buttons = this.contentEl.createDiv({ cls: "brainiac-wizard-modal-buttons brainiac-wizard-context-buttons" });
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons).setButtonText("Save for this chat").setCta().onClick(() => void this.save(false));
		new ButtonComponent(buttons).setButtonText("Save as default too").onClick(() => void this.save(true));
	}

	private renderSelected(): void {
		this.selectedEl.empty();
		if (!this.selected.size) {
			this.selectedEl.createSpan({ cls: "brainiac-wizard-context-empty", text: "No context notes selected." });
			return;
		}
		for (const path of this.selected) {
			const pill = this.selectedEl.createDiv({ cls: "brainiac-wizard-context-pill" });
			pill.createSpan({ text: path });
			const remove = pill.createEl("button", { cls: "clickable-icon", attr: { "aria-label": `Remove ${path} from context` } });
			setIcon(remove, "x");
			remove.addEventListener("click", () => {
				this.selected.delete(path);
				this.renderSelected();
				this.renderResults();
			});
		}
	}

	private renderResults(): void {
		this.resultsEl.empty();
		const query = this.searchEl.value.trim().toLocaleLowerCase();
		const matches = this.app.vault
			.getMarkdownFiles()
			.filter((file) => !query || file.path.toLocaleLowerCase().includes(query) || file.basename.toLocaleLowerCase().includes(query))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
		const shown = matches.slice(0, MAX_RESULTS);
		for (const file of shown) this.renderFile(file);
		if (!shown.length) this.resultsEl.createDiv({ cls: "brainiac-wizard-context-empty", text: "No matching notes." });
		if (matches.length > MAX_RESULTS) {
			this.resultsEl.createDiv({ cls: "brainiac-wizard-context-hint", text: `Showing ${MAX_RESULTS} notes. Refine the search to find more.` });
		}
	}

	private renderFile(file: TFile): void {
		const label = this.resultsEl.createEl("label", { cls: "brainiac-wizard-context-result" });
		const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
		checkbox.checked = this.selected.has(file.path);
		label.createSpan({ cls: "brainiac-wizard-context-result-path", text: file.path });
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) this.selected.add(file.path);
			else this.selected.delete(file.path);
			this.renderSelected();
		});
	}

	private async save(saveAsDefault: boolean): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		try {
			await this.onSave([...this.selected], saveAsDefault);
			this.close();
		} catch (error) {
			this.saving = false;
			new Notice(`Could not save context notes: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
