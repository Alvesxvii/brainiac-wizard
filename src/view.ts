import { ButtonComponent, Component, DropdownComponent, ItemView, Keymap, MarkdownRenderer, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { Agent, ContextNote, Selection } from "./agent";
import { AuthError } from "./auth";
import { Chat, ChatPickerModal, ChatTurn } from "./chats";
import { ContextNotesModal } from "./context-notes-modal";
import type VaultScoutPlugin from "./main";
import { ApiError, streamingUnavailableReason } from "./openai";
import { SignInModal } from "./sign-in-modal";
import { ToolCall } from "./tools";

export const VIEW_TYPE_CHAT = "brainiac-wizard-chat";

const ERROR_HINTS: Record<string, string> = {
	subscription_sharing_usage_limit_exceeded:
		"The weekly limit for Brainiac Wizard is reached. Raise it in ChatGPT settings or wait for the reset.",
	subscription_sharing_user_not_eligible: "Using your plan in other apps needs ChatGPT Plus or Pro.",
	subscription_sharing_usage_unavailable: "Plan usage is temporarily unavailable. Try again shortly.",
	subscription_sharing_invalid_user: "The connection was removed in ChatGPT. Sign in again.",
	invalid_grant: "The ChatGPT connection expired. Sign in again.",
};

function describe(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") return "Stopped.";
	if (error instanceof ApiError || error instanceof AuthError) return ERROR_HINTS[error.code] ?? error.message;
	return error instanceof Error ? error.message : String(error);
}

function toolLabel(call: ToolCall): string {
	const arg = (key: string) => (typeof call.args[key] === "string" ? call.args[key] : "");
	switch (call.name) {
		case "search_notes":
			return `Searching “${arg("query")}”`;
		case "read_note":
			return `Reading ${arg("path")}`;
		case "read_pdf":
			return `Reading PDF ${arg("path")} · page ${typeof call.args.start_page === "number" ? call.args.start_page : 1}${call.args.include_visual === true ? " · visual" : ""}`;
		case "list_folder":
			return `Listing ${arg("path") || "vault root"}`;
		case "get_links":
			return `Following links of ${arg("path")}`;
		case "create_note":
			return `Creating ${arg("path")}`;
		case "edit_note":
			return `Editing ${arg("path")}`;
		case "append_to_note":
			return `Appending to ${arg("path")}`;
		case "check_prism":
			return `Checking Prism blocks in ${arg("path")}`;
		case "get_properties":
			return `Reading properties of ${arg("path")}`;
		case "set_properties":
			return `Updating properties of ${arg("path")}`;
		case "rename_file":
			return `Renaming ${arg("path")} → ${arg("new_path")}`;
		case "ask_user":
			return "Asking you a question";
		case "load_skill":
			return `Loading skill ${arg("name")}`;
		case "read_skill_file":
			return `Reading ${arg("file")} of skill ${arg("name")}`;
		default:
			return call.name;
	}
}

export class ChatView extends ItemView {
	private agent: Agent;
	private chat: Chat;
	private titleEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButton!: ButtonComponent;
	private modelDropdown!: DropdownComponent;
	private accountEl!: HTMLElement;
	private noteButton!: HTMLElement;
	private internetButton!: HTMLElement;
	private contextButton!: HTMLElement;
	private contextToggleButton!: HTMLElement;
	private messageComponents: Component[] = [];
	private abort: AbortController | undefined;
	private streamingNoteShown = false;
	private attachmentsEl!: HTMLElement;
	private images: string[] = [];
	private selection: Selection | undefined;

	constructor(leaf: WorkspaceLeaf, private plugin: VaultScoutPlugin) {
		super(leaf);
		this.agent = new Agent(plugin.auth, plugin.tools);
		this.chat = plugin.chats.newChat(plugin.settings.model, plugin.settings.defaultContextNotes);
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return "Brainiac Wizard";
	}

	override getIcon(): string {
		return "telescope";
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("brainiac-wizard");

		const header = root.createDiv({ cls: "brainiac-wizard-header" });
		this.modelDropdown = new DropdownComponent(header).onChange(async (value) => {
			this.plugin.settings.model = value;
			await this.plugin.saveSettings();
		});
		this.modelDropdown.selectEl.addClass("brainiac-wizard-model");
		this.iconButton(header, "history", "Chats", () => this.pickChat());
		this.noteButton = this.iconButton(header, "file-text", "Open chat as note", () => {
			if (this.chat.file) void this.app.workspace.getLeaf("tab").openFile(this.chat.file);
		});
		this.iconButton(header, "square-pen", "New chat", () => this.newChat());

		const featureToolbar = root.createDiv({ cls: "brainiac-wizard-feature-toolbar" });
		this.contextButton = this.iconButton(featureToolbar, "book-open", "", () => this.openContextPicker());
		this.contextButton.addClass("brainiac-wizard-context-button");
		this.contextToggleButton = this.iconButton(featureToolbar, "eye-off", "", () => void this.toggleContextNotes());
		this.contextToggleButton.addClass("brainiac-wizard-context-toggle");
		this.updateContextButtons();
		this.internetButton = this.iconButton(featureToolbar, "globe", "", () => void this.toggleInternetSearch());
		this.internetButton.addClass("brainiac-wizard-internet-toggle");
		this.updateInternetButton();
		// Images: the iOS picker offers the photo library, the camera and files.
		const picker = featureToolbar.createEl("input", { cls: "brainiac-wizard-file-input", attr: { type: "file", accept: "image/*", multiple: "" } });
		this.registerDomEvent(picker, "change", () => {
			void this.addImages(Array.from(picker.files ?? []));
			picker.value = "";
		});
		this.iconButton(featureToolbar, "image-plus", "Attach images", () => picker.click()).addClass("brainiac-wizard-attach");

		this.titleEl = root.createDiv({ cls: "brainiac-wizard-title" });
		this.accountEl = root.createDiv({ cls: "brainiac-wizard-account" });
		this.messagesEl = root.createDiv({ cls: "brainiac-wizard-messages" });
		this.registerDomEvent(this.messagesEl, "click", (evt) => this.openLink(evt));

		this.attachmentsEl = root.createDiv({ cls: "brainiac-wizard-attachments is-hidden" });
		const composer = root.createDiv({ cls: "brainiac-wizard-composer" });
		this.inputEl = composer.createEl("textarea", { attr: { placeholder: "Ask about your notes…", rows: "3" } });
		this.registerDomEvent(this.inputEl, "paste", (evt) => {
			const items = Array.from(evt.clipboardData?.items ?? []);
			const images = items
				.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter((file): file is File => file !== null);
			if (!images.length) return;
			evt.preventDefault();
			void this.addImages(images);
		});
		this.registerDomEvent(this.inputEl, "keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing && !Platform.isMobile) {
				evt.preventDefault();
				void this.submit();
			}
		});
		this.sendButton = new ButtonComponent(composer).setIcon("send").setCta().setTooltip("Send");
		this.sendButton.onClick(() => (this.abort ? this.abort.abort() : void this.submit()));

		this.register(this.plugin.auth.onChange(() => void this.refreshAccount()));
		this.updateHeader();
		await this.refreshAccount();
	}

	override async onClose(): Promise<void> {
		this.abort?.abort();
	}

	/** Scopes the next question to text selected in a note. */
	setSelection(selection: Selection): void {
		this.selection = selection;
		this.renderAttachments();
		this.inputEl.focus();
	}

	private async addImages(files: File[]) {
		for (const file of files.slice(0, 4 - this.images.length)) {
			try {
				this.images.push(await imageDataUrl(file));
			} catch {
				new Notice(`${file.name} could not be read as an image.`);
			}
		}
		this.renderAttachments();
	}

	private renderAttachments() {
		const el = this.attachmentsEl;
		el.empty();
		el.toggleClass("is-hidden", !this.selection && !this.images.length);
		const selection = this.selection;
		if (selection) {
			const pill = el.createDiv({ cls: "brainiac-wizard-pill" });
			pill.createSpan({ text: `Selection · ${selection.path.split("/").pop() ?? selection.path}, ${lineLabel(selection)}` });
			const remove = pill.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove selection" } });
			setIcon(remove, "x");
			remove.addEventListener("click", () => {
				this.selection = undefined;
				this.renderAttachments();
			});
		}
		this.images.forEach((url, index) => {
			const thumb = el.createDiv({ cls: "brainiac-wizard-thumb" });
			thumb.createEl("img", { attr: { src: url, alt: `Attached image ${index + 1}` } });
			const remove = thumb.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove image" } });
			setIcon(remove, "x");
			remove.addEventListener("click", () => {
				this.images.splice(index, 1);
				this.renderAttachments();
			});
		});
	}

	pickChat(): void {
		new ChatPickerModal(
			this.app,
			this.plugin.chats,
			(file) => void this.openChat(file),
			(file) => {
				if (this.chat.file?.path !== file.path) return;
				this.agent.reset();
				this.chat = this.plugin.chats.newChat(this.plugin.settings.model, this.plugin.settings.defaultContextNotes);
				this.clearMessages();
				this.updateHeader();
			},
		).open();
	}

	async openChat(file: TFile): Promise<void> {
		this.abort?.abort();
		this.chat = await this.plugin.chats.load(file);
		await this.agent.load(this.chat.turns, this.chat.skills);
		this.clearMessages();
		for (const turn of this.chat.turns) {
			this.messagesEl.createDiv({ cls: "brainiac-wizard-message is-user", text: turn.user });
			if (turn.steps.length) {
				const steps = new StepList(this.messagesEl);
				for (const step of turn.steps) steps.add(step);
				steps.finish();
			}
			if (turn.answer) await this.renderMarkdown(this.messagesEl.createDiv({ cls: "brainiac-wizard-message is-assistant" }), turn.answer);
		}
		this.updateHeader();
		this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		this.registerDomEvent(button, "click", onClick);
		return button;
	}

	private updateHeader() {
		this.titleEl.setText(this.chat.title);
		this.titleEl.toggleClass("is-hidden", !this.chat.title);
		this.noteButton.toggleClass("is-hidden", !this.chat.file);
		this.updateContextButtons();
	}

	private updateContextButtons() {
		if (!this.contextButton || !this.contextToggleButton) return;
		const count = this.chat.contextNotes.length;
		const pickerLabel = count ? `Context notes · ${count} selected` : "Choose context notes";
		this.contextButton.setAttribute("aria-label", pickerLabel);
		this.contextButton.setAttribute("title", pickerLabel);
		if (count === 0) this.contextToggleButton.setAttribute("disabled", "");
		else this.contextToggleButton.removeAttribute("disabled");
		const enabled = count > 0 && this.chat.contextEnabled;
		const toggleLabel = enabled ? "Context notes on" : count ? "Context notes off" : "Select context notes first";
		this.contextToggleButton.setAttribute("aria-label", toggleLabel);
		this.contextToggleButton.setAttribute("aria-pressed", String(enabled));
		this.contextToggleButton.setAttribute("title", toggleLabel);
		setIcon(this.contextToggleButton, enabled ? "eye" : "eye-off");
		this.contextToggleButton.toggleClass("is-active", enabled);
	}

	private openContextPicker() {
		new ContextNotesModal(this.app, this.chat.contextNotes, async (paths, saveAsDefault) => {
			const hadNotes = this.chat.contextNotes.length > 0;
			this.chat.contextNotes = paths;
			if (!paths.length) this.chat.contextEnabled = false;
			else if (!hadNotes) this.chat.contextEnabled = true;
			await this.plugin.chats.save(this.chat);
			if (saveAsDefault) {
				this.plugin.settings.defaultContextNotes = [...paths];
				await this.plugin.saveSettings();
			}
			this.updateHeader();
			new Notice(saveAsDefault ? "Context notes saved for this chat and as the default for new chats." : "Context notes saved for this chat.");
		}).open();
	}

	private async toggleContextNotes() {
		if (!this.chat.contextNotes.length) return;
		this.chat.contextEnabled = !this.chat.contextEnabled;
		this.updateContextButtons();
		try {
			await this.plugin.chats.save(this.chat);
		} catch (error) {
			this.chat.contextEnabled = !this.chat.contextEnabled;
			this.updateContextButtons();
			new Notice(`Could not save the chat context setting: ${describe(error)}`);
		}
	}

	private async selectedContextNotes(): Promise<ContextNote[]> {
		if (!this.chat.contextEnabled) return [];
		const context: ContextNote[] = [];
		let remaining = 80_000;
		let omitted = 0;
		for (const path of this.chat.contextNotes) {
			if (remaining <= 0) {
				omitted++;
				continue;
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== "md") {
				new Notice(`Context note not found: ${path}`);
				continue;
			}
			const content = await this.app.vault.cachedRead(file);
			const included = content.slice(0, Math.min(content.length, remaining, 30_000));
			context.push({ path: file.path, content: included });
			remaining -= included.length;
			if (included.length < content.length) omitted++;
		}
		if (omitted) new Notice(`${omitted} context note${omitted === 1 ? " was" : "s were"} shortened to fit the chat context.`);
		return context;
	}

	private updateInternetButton() {
		if (!this.internetButton) return;
		const enabled = this.plugin.settings.webSearchEnabled;
		const label = enabled ? "Internet search on · Vault + Internet" : "Internet search off · Vault only";
		this.internetButton.setAttribute("aria-label", label);
		this.internetButton.setAttribute("aria-pressed", String(enabled));
		this.internetButton.setAttribute("title", label);
		this.internetButton.toggleClass("is-active", enabled);
	}

	private async toggleInternetSearch() {
		this.plugin.settings.webSearchEnabled = !this.plugin.settings.webSearchEnabled;
		this.updateInternetButton();
		await this.plugin.saveSettings();
	}

	private async refreshAccount() {
		const connection = this.plugin.auth.connection;
		this.accountEl.empty();
		this.accountEl.toggleClass("is-hidden", !!connection);
		this.modelDropdown.setDisabled(!connection);
		if (!connection) {
			this.accountEl.createDiv({ text: "Connect your ChatGPT plan to research your vault." });
			new ButtonComponent(this.accountEl)
				.setButtonText("Sign in with ChatGPT")
				.setCta()
				.onClick(() => new SignInModal(this.app, this.plugin.auth).open());
			return;
		}
		try {
			const models = await this.plugin.loadModels();
			this.modelDropdown.selectEl.empty();
			for (const model of models) this.modelDropdown.addOption(model.slug, model.displayName);
			const current = models.find((m) => m.slug === this.plugin.settings.model) ?? models[0];
			if (current) {
				this.modelDropdown.setValue(current.slug);
				this.plugin.settings.model = current.slug;
			}
		} catch (error) {
			this.accountEl.removeClass("is-hidden");
			this.accountEl.createDiv({ cls: "brainiac-wizard-error", text: describe(error) });
		}
	}

	private newChat() {
		this.abort?.abort();
		this.agent.reset();
		this.chat = this.plugin.chats.newChat(this.plugin.settings.model, this.plugin.settings.defaultContextNotes);
		this.clearMessages();
		this.updateHeader();
	}

	private clearMessages() {
		for (const component of this.messageComponents) this.removeChild(component);
		this.messageComponents = [];
		this.messagesEl.empty();
	}

	private async submit() {
		const text = this.inputEl.value.trim() || (this.images.length ? "What do you see in this image?" : "");
		if (!text || this.abort) return;
		if (!this.plugin.auth.connection) {
			new SignInModal(this.app, this.plugin.auth).open();
			return;
		}
		const images = this.images;
		const selection = this.selection;
		this.images = [];
		this.selection = undefined;
		this.renderAttachments();
		this.inputEl.value = "";
		const userEl = this.messagesEl.createDiv({ cls: "brainiac-wizard-message is-user", text });
		if (selection) userEl.createDiv({ cls: "brainiac-wizard-message-note", text: `About ${selection.path}, ${lineLabel(selection)}` });
		if (images.length) {
			const strip = userEl.createDiv({ cls: "brainiac-wizard-message-images" });
			for (const url of images) strip.createEl("img", { attr: { src: url, alt: "Attached image" } });
		}

		const chat = this.chat;
		// Saved chats keep a note of attachments; images themselves are not stored.
		const notes = [
			...(selection ? [`(About a selection in ${selection.path}, ${lineLabel(selection)})`] : []),
			...(images.length ? [`(${images.length} image${images.length === 1 ? "" : "s"} attached)`] : []),
		];
		const turn: ChatTurn = { user: [text, ...notes].join("\n\n"), steps: [], answer: "" };
		chat.turns.push(turn);
		chat.model = this.plugin.settings.model;

		const abort = (this.abort = new AbortController());
		this.sendButton.setIcon("square").setTooltip("Stop");
		let bubble = this.messagesEl.createDiv({ cls: "brainiac-wizard-message is-assistant is-streaming" });
		const steps = new StepList(this.messagesEl, bubble);
		let streamed = "";
		const scroll = () => this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
		const keepRound = () => {
			if (!streamed) return;
			turn.answer = turn.answer ? `${turn.answer}\n\n${streamed}` : streamed;
			void this.renderMarkdown(bubble, streamed);
			streamed = "";
			bubble = this.messagesEl.createDiv({ cls: "brainiac-wizard-message is-assistant is-streaming" });
		};

		try {
			const contextNotes = await this.selectedContextNotes();
			const incomplete = await this.agent.send({ text, images, selection }, this.plugin.settings.model, this.plugin.settings.extraInstructions, this.plugin.settings.webSearchEnabled, contextNotes, {
				onText: (delta) => {
					streamed += delta;
					bubble.setText(streamed);
					scroll();
				},
				onTool: (call) => {
					const label = toolLabel(call);
					turn.steps.push(label);
					steps.add(label);
					scroll();
				},
				onWebSearch: () => {
					const label = "Searching the web";
					turn.steps.push(label);
					steps.add(label);
					scroll();
				},
				onRoundEnd: keepRound,
			}, abort.signal);
			this.noteStreaming();
			if (incomplete) this.messagesEl.createDiv({ cls: "brainiac-wizard-error", text: `The answer is incomplete (${incomplete}).` });
		} catch (error) {
			this.noteStreaming();
			keepRound();
			this.messagesEl.createDiv({ cls: "brainiac-wizard-error", text: describe(error) });
		} finally {
			steps.finish();
			if (!bubble.hasChildNodes()) bubble.remove();
			if (this.abort === abort) {
				this.abort = undefined;
				this.sendButton.setIcon("send").setTooltip("Send");
			}
			scroll();
		}
		try {
			chat.skills = this.agent.loadedSkills();
			await this.plugin.chats.save(chat);
			if (chat === this.chat) this.updateHeader();
		} catch (error) {
			new Notice(`The chat could not be saved: ${describe(error)}`);
		}
	}

	private noteStreaming() {
		const reason = streamingUnavailableReason();
		if (!reason || this.streamingNoteShown) return;
		this.streamingNoteShown = true;
		this.messagesEl.createDiv({ cls: "brainiac-wizard-tool", text: `Answers arrive at once here, because ${reason}.` });
	}

	private async renderMarkdown(el: HTMLElement, markdown: string) {
		el.empty();
		el.removeClass("is-streaming");
		const component = new Component();
		this.addChild(component);
		this.messageComponents.push(component);
		await MarkdownRenderer.render(this.app, markdown, el, "", component);
	}

	private openLink(evt: MouseEvent) {
		const target = evt.target;
		if (!(target instanceof HTMLElement)) return;
		const link = target.closest("a.internal-link");
		const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
		if (!href) return;
		evt.preventDefault();
		let path = href;
		try {
			path = decodeURIComponent(href);
		} catch {
			// Keep as is.
		}
		void this.app.workspace.openLinkText(path, "", Keymap.isModEvent(evt));
	}
}

/** A turn's research steps as one collapsible line: the latest step while working, the count when done. */
class StepList {
	private details: HTMLDetailsElement | undefined;
	private summary!: HTMLElement;
	private list!: HTMLElement;
	private count = 0;

	constructor(private parent: HTMLElement, private before?: HTMLElement) {}

	add(label: string) {
		if (!this.details) {
			this.details = this.parent.createEl("details", { cls: "brainiac-wizard-steps" });
			if (this.before) this.parent.insertBefore(this.details, this.before);
			this.summary = this.details.createEl("summary");
			this.list = this.details.createDiv();
		}
		this.count++;
		this.list.createDiv({ cls: "brainiac-wizard-tool", text: label });
		this.summary.setText(`${label} (${this.count})`);
	}

	finish() {
		if (this.details) this.summary.setText(`${this.count} research step${this.count === 1 ? "" : "s"}`);
	}
}

function lineLabel(selection: Selection): string {
	return selection.fromLine === selection.toLine ? `line ${selection.fromLine}` : `lines ${selection.fromLine}-${selection.toLine}`;
}

const MAX_IMAGE_SIDE = 1600;

/** Downscales a picked image to JPEG (phone photos are large) and returns it as a data URL. */
async function imageDataUrl(file: File): Promise<string> {
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
		const canvas = createEl("canvas", { attr: { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) } });
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		bitmap.close();
		return canvas.toDataURL("image/jpeg", 0.85);
	} catch {
		return await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("unreadable")));
			reader.onerror = () => reject(new Error("unreadable"));
			reader.readAsDataURL(file);
		});
	}
}
