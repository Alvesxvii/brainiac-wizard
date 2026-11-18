// Copies the built plugin into a vault: node scripts/deploy.mjs <vault path>
import fs from "fs";
import path from "path";

const vault = process.argv[2];
if (!vault || !fs.existsSync(path.join(vault, ".obsidian"))) {
	console.error("Usage: npm run deploy -- <vault path> (the folder that contains .obsidian)");
	process.exit(1);
}
const target = path.join(vault, ".obsidian", "plugins", "vault-scout");
fs.mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	fs.copyFileSync(file, path.join(target, file));
}
fs.copyFileSync("pdf.worker.mjs", path.join(target, "pdf.worker.mjs"));
fs.copyFileSync(path.join("node_modules", "pdfjs-dist", "LICENSE"), path.join(target, "PDFJS-LICENSE"));

function copyDirectory(source, destination) {
	fs.mkdirSync(destination, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		if (entry.isDirectory()) copyDirectory(from, to);
		else if (entry.isFile()) fs.copyFileSync(from, to);
	}
}

for (const directory of ["cmaps", "standard_fonts"]) {
	copyDirectory(path.join("node_modules", "pdfjs-dist", directory), path.join(target, directory));
}
console.log(target);
