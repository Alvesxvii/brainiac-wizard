import { App, normalizePath, TFile } from "obsidian";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_PER_READ = 10;
const MAX_CHARS_PER_READ = 16_000;

export interface PdfReadResult {
	path: string;
	total_pages: number;
	pages: { page: number; text: string }[];
	next_page?: number;
	next_offset?: number;
	no_text_pages?: number[];
}

/** Extracts text locally from one PDF at a time, keeping the parsed document for follow-up page reads. */
export class PdfTextReader {
	private readonly workerSrc: string;
	private readonly cMapUrl: string;
	private readonly standardFontDataUrl: string;
	private active: { path: string; mtime: number; document: PDFDocumentProxy } | undefined;

	constructor(private app: App, pluginDir: string) {
		const adapter = app.vault.adapter;
		this.workerSrc = adapter.getResourcePath(normalizePath(`${pluginDir}/pdf.worker.mjs`));
		this.cMapUrl = `${adapter.getResourcePath(normalizePath(`${pluginDir}/cmaps`))}/`;
		this.standardFontDataUrl = `${adapter.getResourcePath(normalizePath(`${pluginDir}/standard_fonts`))}/`;
	}

	async read(file: TFile, startPage: number, offset: number, requestedPages: number): Promise<PdfReadResult> {
		if (file.stat.size > MAX_PDF_BYTES) {
			throw new Error("This PDF is larger than 25 MB. Split it into smaller files and try again.");
		}
		const document = await this.open(file);
		if (startPage > document.numPages) throw new Error(`Page ${startPage} is beyond the end of this PDF (${document.numPages} pages).`);

		const pageLimit = Math.min(Math.max(requestedPages, 1), MAX_PAGES_PER_READ);
		const pages: PdfReadResult["pages"] = [];
		const noTextPages: number[] = [];
		let remaining = MAX_CHARS_PER_READ;
		let nextPage: number | undefined;
		let nextOffset: number | undefined;

		for (let pageNumber = startPage; pageNumber <= document.numPages && pages.length < pageLimit; pageNumber++) {
			const page = await document.getPage(pageNumber);
			const content = await page.getTextContent();
			const fullText = content.items
				.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
				.join("")
				.replace(/[\t ]+\n/g, "\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
			const pageOffset = pageNumber === startPage ? Math.min(Math.max(offset, 0), fullText.length) : 0;
			const text = fullText.slice(pageOffset);
			if (!text) noTextPages.push(pageNumber);
			if (text.length > remaining) {
				pages.push({ page: pageNumber, text: text.slice(0, remaining) });
				nextPage = pageNumber;
				nextOffset = pageOffset + remaining;
				break;
			}
			pages.push({ page: pageNumber, text });
			remaining -= text.length;
			if (remaining === 0 && pageNumber < document.numPages) {
				nextPage = pageNumber + 1;
				nextOffset = 0;
				break;
			}
		}

		if (nextPage === undefined && startPage + pages.length <= document.numPages) {
			nextPage = startPage + pages.length;
			nextOffset = 0;
		}
		return {
			path: file.path,
			total_pages: document.numPages,
			pages,
			...(nextPage === undefined ? {} : { next_page: nextPage, next_offset: nextOffset ?? 0 }),
			...(noTextPages.length ? { no_text_pages: noTextPages } : {}),
		};
	}

	async dispose(): Promise<void> {
		const active = this.active;
		this.active = undefined;
		if (active) await active.document.destroy();
	}

	private async open(file: TFile): Promise<PDFDocumentProxy> {
		if (this.active?.path === file.path && this.active.mtime === file.stat.mtime) return this.active.document;
		await this.dispose();
		GlobalWorkerOptions.workerSrc = this.workerSrc;
		const data = new Uint8Array(await this.app.vault.readBinary(file));
		const loadingTask = getDocument({
			data,
			cMapUrl: this.cMapUrl,
			cMapPacked: true,
			standardFontDataUrl: this.standardFontDataUrl,
			isEvalSupported: false,
			useSystemFonts: true,
		});
		try {
			const document = await loadingTask.promise;
			this.active = { path: file.path, mtime: file.stat.mtime, document };
			return document;
		} catch (error) {
			await loadingTask.destroy();
			throw error;
		}
	}
}
