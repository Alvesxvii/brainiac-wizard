# Brainiac Wizard

Chat with your Obsidian vault using your ChatGPT plan. Brainiac Wizard searches and reads notes, follows links, reads text and scanned PDFs, and can write approved changes back to the vault. It runs in Obsidian on desktop and mobile.

Brainiac Wizard is a community-maintained fork of [Vault Scout](https://github.com/floorianmb/vault-scout) by floorianmb. It keeps the upstream MIT license and attribution while adding features requested and tested in Obsidian.

## Features

- Search notes by text, title, folder, and tag; read notes and follow links and backlinks.
- Select one or more Markdown notes as persistent chat context. Each chat has its own selection and on/off switch. Save a selection as the default for new chats.
- Optionally enable OpenAI web search. Results include clickable source links; web search is off by default.
- Read PDFs stored in the vault. Extract selectable text locally and use visual analysis for scanned pages, diagrams, and screenshots.
- Attach up to four images from the file picker, or paste images with Ctrl+V. Image data is sent with the request and is not saved in chat notes.
- Create, edit, append, change properties, and rename notes after reviewing and approving each change.
- Save conversations as Markdown notes, reopen them on another device, and permanently delete chats from the history picker.
- Install skills such as Prism and Open Knowledge Format notes.

## Install

After approval in the Obsidian Community directory, install **Brainiac Wizard** from *Settings → Community plugins → Browse*.

For beta testing, install [BRAT](https://github.com/TfTHacker/obsidian42-brat), run *BRAT: Add a beta plugin for testing*, and enter `Alvesxvii/brainiac-wizard`.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from a GitHub release and place them in `<vault>/.obsidian/plugins/brainiac-wizard/`.

## Quick start

1. Open *Settings → Brainiac Wizard → Open chat*, or run *Brainiac Wizard: Open chat* from the command palette.
2. Choose *Sign in with ChatGPT*, open the sign-in page, and approve Brainiac Wizard for plan usage.
3. After approval, the browser shows a page that cannot be reached. That is expected: copy its full address and paste it into the sign-in dialog in Obsidian, then connect.
4. Ask a question about your vault. Use the book icon above the chat title to choose context notes. The eye icon toggles their use for the current conversation.
5. Turn on the globe icon when you want to allow web search. It starts off.

ChatGPT plan usage requires an eligible ChatGPT plan. Brainiac Wizard does not require an API key and does not switch to API billing.

## Chats and context

Chats are Markdown files in the configured chat folder. By default, Brainiac Wizard keeps the inherited `Vault Scout/Chats` path so existing conversations remain available. Each chat's frontmatter stores its selected context note paths and whether context is enabled. The note contents are read from the vault and included in requests while context is on; their contents are not copied into the chat file.

New chats copy the saved default context selection. Changing or disabling context in one chat does not change the others. The chat history trash button permanently deletes the selected chat note. Attached images are not stored as separate vault files, and source notes or PDFs are never removed when a chat is deleted.

## Privacy and network use

- Messages, attached images, selected context note contents, and the relevant note or PDF contents are sent to OpenAI through the Responses API under the signed-in ChatGPT account. Requests use `store: false`.
- PDF text extraction and page rendering happen on the device. Extracted text and rendered pages needed for visual reading are sent to OpenAI as request context; the original PDFs are not copied or modified.
- Web search is optional and off by default. When enabled, Brainiac Wizard makes the hosted Responses API `web_search` tool available to the model. Search results are shown with clickable citations.
- Chat files store conversation text, selected context paths, and attachment counts. Attached image data is not written to the vault.
- OAuth credentials are stored in Obsidian's local secret storage and do not sync. Each device signs in separately.
- There is no analytics or telemetry. GitHub is contacted when installing or updating a skill.

## Build from source

```sh
npm install
npm run build
npm run lint
npm run deploy -- <vault>
```

The build bundles the PDF.js worker, CMaps, and standard font data into `main.js`, so marketplace installations need only the standard plugin release files. `scripts/build-pdf-assets.mjs` regenerates the ignored `src/pdfjs-assets.generated.ts` from the installed `pdfjs-dist` package before each build.

## Acknowledgements and licenses

Brainiac Wizard is based on the MIT-licensed [Vault Scout](https://github.com/floorianmb/vault-scout) by floorianmb. The original copyright and license notice are retained. The bundled PDF.js worker and data files are provided by Mozilla's `pdfjs-dist` package under Apache-2.0 and related notices in [`LICENSES/`](LICENSES/).

## License

MIT. See [`LICENSE`](LICENSE).
