# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, no-build website that turns photos of a JEE test-review app's screen (the questions a student got partially correct / wrong / skipped) into a Word doc: auto-rotated, cropped to drop the "Solution" part, sorted by question number, one question per page. A "Library" keeps past tests. Users: a parent on Windows (Chrome/Edge) and the developer on a Mac.

## Running and testing

There is no build, linter, or test suite. Libraries load from jsDelivr as pinned `<script>` tags in `index.html` (tesseract.js 5.1.1, docx 9.0.3, supabase-js 2.45.0), so a network connection is required.

```bash
python3 -m http.server 8765   # then open http://localhost:8765
```

Testing is manual in a browser. To exercise the OCR without the UI, import the module in the browser console: `const o = await import('./ocr.js?'+Date.now()); await o.analyze(await o.loadPhoto(blob))` (`o._debug` exposes `readPage`, `readHeader`, `screenRect`, `ocr`). Append a cache-busting query to module imports and to the page URL while iterating.

## Configuration and storage modes

`config.js` is gitignored; copy `config.example.js` to `config.js`. Never commit it and never put the Supabase secret key in it (only the project URL and the publishable/anon key).

`store.js` is the only storage interface, with two backends chosen at load time:
- **Supabase** (when `config.js` has both values): email/password login, `tests` table, private `test-images` bucket. Schema and RLS policies are in `supabase-setup.sql`.
- **IndexedDB** (when `config.js` is empty): data stays in that one browser, and there is no login screen. This is the mode to use for local testing so you don't touch the real database. Don't edit the real `config.js` for that; run a copy of the folder with an empty config.

Test shape: `{id, title, subject, date, items:[{id, q, status, note, hide, crop, answerBox, imgPath}]}`. The stored photo is the already-rotated image (max side 1600px JPEG); `crop` and `answerBox` are fractions of that photo, so crops stay editable. Word docs are never stored; they are rebuilt from photos on every download.

## Architecture

- `app.js`: hash router (`#/`, `#/new`, `#/test/<id>`), login, Library, the editor (cards, keyboard shortcuts 1/2/3 and arrows, crop modal), and save/download. Editor state lives in the module-level `st`. Cards are re-rendered individually with `refreshCard`; `renderCards` rebuilds all of them.
- `ocr.js`: photo handling and the analysis pipeline that fills each card in: `analyze(canvas, {autoRotate})` returns the possibly rotated canvas, a Q number guess, a suggested `crop`, and an optional `answerBox` (the "Correct answer" line that can be whited out). `renderCrop` produces the final cropped canvas used by both the thumbnails and the docx.
- `docx-builder.js`: builds the document (Partially Correct, then Wrong, then Skipped; each section sorted by Q; first question shares a page with its heading, later ones start a new page). `buildDocx` takes a `renderItem` callback so it is independent of where images come from.

## OCR pipeline behaviour (hard-won; change carefully)

- Tesseract must be given the lit tablet-screen area, not the whole photo. `screenRect` finds it by walking out from the centre until the image goes dark; `readPage` falls back to contrast-boosted and whole-photo reads when the score is poor.
- Orientation is chosen by trying all four rotations and scoring `pageConf` plus "uprightness" (words wider than tall). Confidence alone fails because Tesseract reads sideways text well. Manual rotation calls `analyze` with `autoRotate:false` so the automatic check never undoes it.
- The big "< Q 42 >" header is read separately (`readHeader`): digit-only whitelist, narrow top bands at several scales, voting. The ">" chevron is often read as an extra digit, so `parseHeaderToken` uses glyph widths and a two-digit cap. The number is still only a guess, and the UI highlights it (`qGuess`) for the user to confirm.
- The "Solution" label (left edge, below the Q header) marks the bottom of the crop; "Correct answer" is the fallback.
- docx must stay at v9+ because v8's `ImageRun` ignores `type: "jpg"` and writes JPEG data as `.png`.

## Deployment

Static hosting only (Netlify Drop was used: zip `index.html app.js ocr.js store.js docx-builder.js styles.css config.js` with those files at the zip root, and include the real `config.js`). `SETUP.md` has the Supabase and hosting setup steps for non-developers.
