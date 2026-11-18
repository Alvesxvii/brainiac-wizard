import { App, TFile } from "obsidian";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFJS_ASSETS } from "./pdfjs-assets.generated";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_PER_READ = 10;
const MAX_CHARS_PER_READ = 16_000;
const MAX_VISUAL_PAGES_PER_READ = 3;
const MAX_RENDERED_SIDE = 1800;

export interface PdfReadResult {
	path: string;
	total_pages: number;
	pages: { page: number; text: string }[];
	next_page?: number;
	next_offset?: number;
	no_text_pages?: number[];
	visual_pages?: number[];
	visual_pages_remaining?: number[];
	visual_render_errors?: number[];
}

export interface PdfPageImage {
	path: string;
	page: number;
	dataUrl: string;
}

export interface PdfReadExecution {
	result: PdfReadResult;
	images: PdfPageImage[];
}

/** Extracts text locally from one PDF at a time, keeping the parsed document for follow-up page reads. */
export class PdfTextReader {
	private workerSrc: string | undefined;
	private active: { path: string; mtime: number; document: PDFDocumentProxy } | undefined;

	constructor(private app: App) {}

	async read(file: TFile, startPage: number, offset: number, requestedPages: number, includeVisual: boolean): Promise<PdfReadExecution> {
		if (file.stat.size > MAX_PDF_BYTES) {
			throw new Error("This PDF is larger than 25 MB. Split it into smaller files and try again.");
		}
		const document = await this.open(file);
		if (startPage > document.numPages) throw new Error(`Page ${startPage} is beyond the end of this PDF (${document.numPages} pages).`);

		const pageLimit = Math.min(Math.max(requestedPages, 1), includeVisual ? MAX_VISUAL_PAGES_PER_READ : MAX_PAGES_PER_READ);
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
		const pagesToRender = includeVisual ? pages.map(({ page }) => page) : noTextPages;
		const renderedPages = pagesToRender.slice(0, MAX_VISUAL_PAGES_PER_READ);
		const images: PdfPageImage[] = [];
		const renderErrors: number[] = [];
		for (const pageNumber of renderedPages) {
			try {
				images.push({ path: file.path, page: pageNumber, dataUrl: await this.renderPage(document, pageNumber) });
			} catch {
				renderErrors.push(pageNumber);
			}
		}
		return {
			result: {
				path: file.path,
				total_pages: document.numPages,
				pages,
				...(nextPage === undefined ? {} : { next_page: nextPage, next_offset: nextOffset ?? 0 }),
				...(noTextPages.length ? { no_text_pages: noTextPages } : {}),
				...(images.length ? { visual_pages: images.map(({ page }) => page) } : {}),
				...(pagesToRender.length > renderedPages.length ? { visual_pages_remaining: pagesToRender.slice(renderedPages.length) } : {}),
				...(renderErrors.length ? { visual_render_errors: renderErrors } : {}),
			},
			images,
		};
	}

	async dispose(): Promise<void> {
		const active = this.active;
		this.active = undefined;
		if (active) await active.document.destroy();
		if (this.workerSrc) URL.revokeObjectURL(this.workerSrc);
		this.workerSrc = undefined;
	}

	private async open(file: TFile): Promise<PDFDocumentProxy> {
		if (this.active?.path === file.path && this.active.mtime === file.stat.mtime) return this.active.document;
		await this.dispose();
		this.workerSrc ??= URL.createObjectURL(new Blob([PDFJS_ASSETS.worker], { type: "text/javascript" }));
		GlobalWorkerOptions.workerSrc = this.workerSrc;
		const data = new Uint8Array(await this.app.vault.readBinary(file));
		const loadingTask = getDocument({
			data,
			cMapPacked: true,
			CMapReaderFactory: EmbeddedCMapReaderFactory,
			StandardFontDataFactory: EmbeddedStandardFontDataFactory,
			useWorkerFetch: false,
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

	private async renderPage(document: PDFDocumentProxy, pageNumber: number): Promise<string> {
		const page = await document.getPage(pageNumber);
		const initialViewport = page.getViewport({ scale: 1 });
		const scale = Math.min(MAX_RENDERED_SIDE / Math.max(initialViewport.width, initialViewport.height), 2);
		const viewport = page.getViewport({ scale });
		const canvas = window.document.createElement("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Could not render this PDF page as an image.");
		try {
			await page.render({ canvasContext: context, viewport }).promise;
			return canvas.toDataURL("image/jpeg", 0.85);
		} finally {
			canvas.width = 0;
			canvas.height = 0;
			page.cleanup();
		}
	}
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

const cmapCache = new Map<string, Uint8Array>();
const fontCache = new Map<string, Uint8Array>();

class EmbeddedCMapReaderFactory {
	constructor(_options: { baseUrl?: string | null; isCompressed?: boolean }) {}

	async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
		const filename = `${name}.bcmap`;
		let cMapData = cmapCache.get(filename);
		if (!cMapData) {
			const encoded = PDFJS_ASSETS.cmaps[filename as keyof typeof PDFJS_ASSETS.cmaps];
			if (!encoded) throw new Error(`The PDF character map ${filename} is not bundled.`);
			cMapData = decodeBase64(encoded);
			cmapCache.set(filename, cMapData);
		}
		return { cMapData, isCompressed: true };
	}
}

class EmbeddedStandardFontDataFactory {
	constructor(_options: { baseUrl?: string | null }) {}

	async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
		let fontData = fontCache.get(filename);
		if (!fontData) {
			const encoded = PDFJS_ASSETS.standardFonts[filename as keyof typeof PDFJS_ASSETS.standardFonts];
			if (!encoded) throw new Error(`The PDF standard font ${filename} is not bundled.`);
			fontData = decodeBase64(encoded);
			fontCache.set(filename, fontData);
		}
		return fontData;
	}
}
