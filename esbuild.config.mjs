import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	// Lower import() to require(): the Obsidian renderer cannot resolve a native
	// import() of Node modules such as "https" (desktop-only, behind Platform.isDesktop).
	supported: { "dynamic-import": false },
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
});

const pdfWorker = await esbuild.context({
	entryPoints: ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
	bundle: true,
	format: "esm",
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "pdf.worker.mjs",
});

if (prod) {
	await Promise.all([context.rebuild(), pdfWorker.rebuild()]);
	await Promise.all([context.dispose(), pdfWorker.dispose()]);
	process.exit(0);
} else {
	await Promise.all([context.watch(), pdfWorker.watch()]);
}
