# GrindPeople AI Rules

> Product type: PWA. **These are all the rules for this product; there is no shared rules file.** The product rules come first, then "Grind rules" and "PWA rules" at the end, which apply to all work here: read the whole file before starting. The product rules win on their own details.
> The `.people` file (SQLite, optional `GRINDEN2` encryption) is also read and written by `../grind-people-mac`, and the two must stay byte-compatible. Check `../grind-people-mac/docs/people-file-format.md` before changing the schema, the format or the encryption (this includes the file password feature).

## 1. Stack

- Vanilla JavaScript, no frontend framework.
- Wasm SQLite (`sql.js`): the database lives in memory. Manage memory explicitly (`stmt.free()`, `db.close()` before re-instantiating) to prevent leaks.
- Tailwind CSS v4.3.1. `./build.sh` downloads the standalone binary for the current OS on first run and checks its pinned SHA-256. The binary is git-ignored.

## 2. Data and files

- Files: `.people` (the database), plus `.vcf` and `.csv` import/export.
- SQL: ALWAYS use parameterized queries (`db.prepare("... WHERE id = ?")`). Never interpolate variables into SQL strings.
- `sql.js` does not auto-persist. Every INSERT, UPDATE or DELETE must call `setDirty(true)` so the user is warned before closing the tab.
- IndexedDB (`GrindPeopleDB`) holds only the auto-draft of the database (`saveDraft()` on `draftTimer`).

## 3. UI

- Look, top bar, shortcuts, toasts, dialogs, wording and languages follow the UI section of the PWA rules below. Do not restate them here; add only what differs.
- Product-specific top-bar controls: the Settings button, placed before the file password field. The Settings dialog must not hold a theme choice (light only).
- UI languages: English and Japanese, in `lang/`, applied by `i18n.js` (shared with grind-cash, the other app with several languages).

## 4. Known gaps against the PWA rules below

- `sw.js` has an inline offline fallback page with Japanese text. It stays: it is shown only when the app cannot load.
- Japanese fallback text in `index.html` (shown only before `lang/` loads) and Japanese comments in `main.js` stay: Grind rules §5 do not require rewriting existing comments.

## Grind rules

Rules that hold for every Grind product, kept here in full (there is no shared rules file). The product rules above win on their own details, but cannot loosen §4 (data safety) or a rule marked "never"; if one must, ask the owner first. § numbers refer to the sections below.

These rules describe the current direction, not limits on the owner. When the owner asks for something a rule seems to block, name the rule and ask whether to change it; never refuse the request because of the rule.

### 1. How Grind decides

- Do one thing well. Remove before adding. When unsure, leave it out.
- Calm, obvious operation and quiet design come before feature count.
- Fix problems with better defaults, not more settings.
- Users are busy people, not engineers. The main flows must work without reading instructions.
- Propose a feature only when it passes these rules. Do not suggest anything outside a product's scope.

### 2. Offline is peace

Products that run on the user's device. A product whose job needs the network (a server, an online service) says so in its product rules.

- Local-first: the user's data stays on their own device, in files they own. No account.
- No automatic communication: no telemetry, analytics, crash reporting, update pings, external APIs, cloud services or built-in AI. Network use only on an explicit user action, and only where the product's rules allow it. Updates and purchases handled by the platform's own store are allowed.
- No automatic or real-time sync. Moving data is an explicit export / import by the user.
- Products hand data to each other and to other apps with standard formats (plain text, Markdown, HTML, CSV, vCard, PDF, images), never only a Grind-specific one.
- No API keys and no paid or hosted services. Heavy work runs on the user's device, or uses "bring your own AI": the product makes a prompt the user pastes into their own AI tool.

### 3. Stores and pricing

- Pricing is decided per product and written in its product rules: free, paid upfront, a free trial, in-app purchase or subscription may all fit. Whatever the model, the user's own data stays readable and exportable without paying again.
- Store listings follow each store's own rules; the platform rules record what a store has rejected before.

### 4. Data safety

- Never lose data silently. Ask before discarding work, and make changes undoable where possible.
- Treat everything from files, pastes, devices and other apps as untrusted: escape it for display, bind it in SQL, bound its size.
- Secrets never go in plain files, logs or URLs. Keep them in the platform's secure storage where it has one.

### 5. Code

- Identifiers, code, comments, console messages and commit messages in concise English. User-facing text follows the product's languages.
- Comments: none. Write a comment only where the code would be misread without it (a non-obvious reason, a safety boundary, a trap), and keep it to one short line. No narration of what the code does, no doc comments on every declaration, no commented-out code. Third-party license notices stay as shipped. Markers read by a product's own check script (such as `// l10n: fixed`) are allowed. The product rules above may be stricter.
  - Much existing code carries long comments that agents added against this rule. They are not a style to follow: never add comments to match the code around them. Do not remove them in unrelated changes either; trim them only when asked or when rewriting that code.
- Prefer the platform's own tools and few dependencies. The product and platform rules name the stack.

### 6. Working with AI agents

- Chat explanations in Japanese.
- Before saying something is done, run all of the product's tests (every suite, not only those near the change; correctness matters more than the time it takes) and exercise the change; report anything left unverified.
- When behavior changes, update the product's docs in the same change.
- Before every commit, check all of these, and say in the chat that you did:
  1. All of the product's tests pass (above).
  2. Docs: search the product's spec and docs (`SPEC.md`, `README.md`, `docs/`, store copy) for what the change touches. Any line the change makes wrong or incomplete is updated in the same commit. A new behavior with no line yet gets one. If nothing needs changing, say which files you searched.
  3. Comments: the diff adds none beyond what §5 allows.
  4. The product's own checks named in its product rules (localization, icon) for what the change touches.
- Commit or push only when asked.
- One developer: commit small changes straight to `main`. Use a work branch only for a large or risky change, merge it into `main` (fast-forward) once the tests pass, then delete it. No pull requests unless asked (for example, to run a review on the diff).
- Do not drive the user's screen while they may be using the computer. Prefer tests, background launches, simulators or emulators and off-screen rendering; never send keystrokes that could reach another app.
- Before suggesting an optimization, follow the real data flow instead of pattern-matching.
- Audit and review findings, including those from other AI tools, are claims to check, not tasks to apply. For each one, confirm that it can really happen (a repro, a failing test, or an order of events the platform actually produces) and how much harm it does. Then fix it, record it as an accepted risk in the product's docs, or reject it, and say which and why.
  - Leave out cases that are extremely unlikely in real use and minor in impact. Do not add code or machinery for them.
  - A case that can lose or corrupt user data (§4), or stop the app from launching, saving or quitting, is never minor.
  - Fix with the smallest change, and add a test that fails without it.
  - When findings keep coming round after round on the same area, stop and ask the owner whether the design should be simpler, instead of adding another fix.

## PWA rules

The detailed rules for the Grind PWAs. The product rules above add storage, file format and design rules and list known gaps against these; they cannot loosen these rules (ask the owner first).

The PWAs are mostly maintained today: fix what is broken and keep changes small unless the owner asks for more, and do not rewrite working code only to match these rules. New or changed code follows them; known deviations stay listed under the known gaps above until the owner decides to fix them.

### Runtime and build

- Runs entirely in the browser: HTML, vanilla JavaScript and Tailwind CSS (plus Alpine.js in grind-qrcoder only). No backend and no server-side code.
- Serve over HTTPS or `localhost`. `file://` is not supported: the Service Worker cannot register there.
- No bundlers and no runtime build step (no Webpack, Vite, or ES modules that need building). The only build step is compiling Tailwind into the committed `styles.css` with `./build.sh` during development (grind-cash also offers `npm run build`, which runs the same command). Tailwind is built only through `./build.sh` (see "Files and build").
- Self-host every asset: scripts, styles, images and icons. System fonts only; no web fonts. No CDNs or third-party hosts.
- Keep the existing Tailwind CSS (and Alpine.js in grind-qrcoder). Do not migrate off them or add new frameworks.

### Offline and updates (Service Worker)

- List every file the app can load in the `sw.js` precache, including libraries that load lazily: `index.html`, scripts, `styles.css`, `lang/*.js`, the manifest and the icons.
- A PWA is downloaded from a web server and cached by its Service Worker; after that it must not call out (Grind rules §2). Serve precached files from the current version's cache only. Never revalidate them in the background or fetch them network-first: after the first load the app makes no network requests on its own. The browser's periodic `sw.js` update check is the only allowed automatic request.
- Bump `CACHE_NAME` (`<product>-vYYYYMMDD-N`) in the same change whenever any precached file changes. Without the bump, installed apps never receive the change.
- On `activate`, delete the caches of the same product (same name prefix) that differ from `CACHE_NAME`.
- A new version waits until the user chooses to update: show an update prompt, then send `SKIP_WAITING` to the waiting worker and reload when it takes control. Never call `skipWaiting()` on install.

### Icons

- Use one inline SVG sprite in `index.html` and reference icons with `<use href="#icon-id">`. No external sprite files and no icon fonts.
- Add a `<symbol>` before using a new icon, and remove symbols that are no longer referenced.

### Data and files

- User data stays in the browser (IndexedDB, or in-memory `sql.js`) and in files the user saves. Read and write those files locally (File System Access API, with download/upload fallbacks where the browser lacks it). Never upload user files to a server.
- When the user sets a file password, encrypt with Web Crypto AES-256-GCM in the `GRINDEN2` format, documented in `grind-people-mac/docs/people-file-format.md`.
- Treat opened, dropped, pasted and shared data as untrusted: bound its size, validate it, wrap decryption and parsing (JSON, CSV) in `try...catch`, and fail with a toast or dialog that lets the user retry without reloading.
- Track unsaved changes with `isDirty` / `setDirty()` and warn before the tab closes. Never rely on async work in `beforeunload` or `visibilitychange` to save data; the browser may kill it. Keep a draft of unsaved work in IndexedDB on debounced timers while the app is active. The draft is not the user's file; saving the file stays an explicit user action.
- Passwords and other secrets never go in logs or URLs.
- The clipboard always gets `text/plain` (Markdown text for a list, vCard text for a contact), plus `text/html` or `image/png` where the content needs it. Never custom clipboard formats.
- Revoke object URLs when done, and avoid deep-copying large Base64 strings (logos, images).

### UI

The four PWAs must feel like one product family. A user who knows one should find the same things in the same places in the others. A product may differ in its content, never in the rules below. One exception: grind-qrcoder is a generator tool with tabs and cards, not a record list, so it keeps its own layout, shapes (corner radius, shadows) and its own notification (`flash-toast`, placed by the app instead of `showToast`). Its colors, font, top-bar controls, shortcuts, dialogs and update prompt follow the rules.

- Style with Tailwind utility classes. Custom CSS (`<style>` or `input.css`) only where Tailwind cannot express it.
- Forms never reload the page. Keep focus on inputs after actions. Transitions must not shift the layout.
- Keep the UI clean; put advanced actions in the command palette (Cmd/Ctrl+K).

#### Look

- Light theme only: `color-scheme: light`, no `dark:` classes, and `input.css` disables the `dark` variant (`@custom-variant dark (&:where(.never-used));`). The OS theme is ignored.
- One `@theme` token set: the `--color-*`, `--font-sans` and `--animate-*` lines are identical in all four `input.css` files (grind-qrcoder also defines `--shadow-*` tokens):
  - `--color-primary: oklch(54.6% 0.245 262.881)`, `--color-primary-hover: oklch(48.8% 0.243 264.376)`, `--color-primary-50: oklch(97% 0.014 254.604)`, `--color-primary-100: oklch(93.2% 0.032 255.585)`. These are the Tailwind v4 `blue-600`, `blue-700`, `blue-50` and `blue-100` values, written out so the token does not depend on the palette.
  - `--font-sans`: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif` (system fonts only).
  - Every `--animate-*` token (`--animate-modal-in`, `--animate-toast-in` and the others) uses the same durations and easing.
- Use `primary`, `primary-hover`, `primary-50` and `primary-100` (with opacity modifiers) for buttons, selected states, links, focus rings and their tints; never a hard-coded hex or `blue-600`. Other colors come from Tailwind's default palette (`red` for danger, `amber` for warnings, `emerald` for success). No other brand color.
- Neutrals: page `bg-slate-50`, cards and panels white with `border-slate-200`, body text `text-slate-900`, secondary text `text-slate-500`, toasts `bg-slate-900` with white text.
- Shape (grind-qrcoder excepted): controls (buttons, inputs, selects) `rounded-md`; cards and panels `rounded-xl`; dialogs `rounded-2xl`. Shadows stay soft; no heavy shadows or gradients on controls.
- Safe areas: `viewport-fit=cover` and `env(safe-area-inset-*)` padding, so the app works as an installed PWA on a phone.

#### Frame and controls

- Top bar, left to right: product icon and name; file-name badge (for a file that is not saved yet, `Unsaved.<ext>`, with the unsaved marker); then the shared controls in this fixed order: file password field with its show/hide button, Open, Save, command palette (Cmd/Ctrl+K). Product-specific controls (language, currency, dictionary, settings) go before the file password field, never between the shared ones, and never replace them.
- Shared shortcuts: Cmd/Ctrl+O open, Cmd/Ctrl+S save, Cmd/Ctrl+K command palette. Alt+N creates a new item in the apps that have one main list (cash, money, people). The shortcut is shown in the button's tooltip.
- Dropping a file on the window opens it, with the same full-window drop overlay in every app.
- Unsaved state: the unsaved badge (`dirty-badge`) shows it and the tab title starts with `* ` (grind-qrcoder: badge only), and closing the tab warns (see Data and files).
- Empty states use the same pattern: a large icon, a one-line title, a one-sentence hint and one primary action.

#### Messages

- One toast function in every app except grind-qrcoder: `showToast(message, iconHtml, ...)`. The third argument is `type` (`"normal"`, `"warning"` or `"error"`) in grind-people, and an options object `{ duration, rawHtml }` in grind-cash and grind-money (cash's undo toast needs `rawHtml`). The toast is a dark pill (`bg-slate-900`, white text) at the top center, the same for every `type` (`type` only changes the icon color), one at a time (a new toast replaces the old one), shown for 3 seconds. Messages are escaped as text.
- One set of dialog functions in every app, each returning a Promise: `appAlert(message, title?)` resolves when the user closes it, `appConfirm(message, title?)` resolves `true` or `false`, and `appPrompt(message, defaultValue = '', { type: 'text' | 'password', title? })` resolves the entered text, or `null` on cancel. A dialog without a title bar ignores `title`. The browser's `alert()`, `confirm()` and `prompt()` are never used. A confirm puts Cancel first (the left button) and gives it the initial focus, so a stray Enter never confirms. The main button keeps the primary color, even for a destructive action.
- Error text says what happened and what the user can do next, in one or two sentences. Never show a raw exception message; log it with `console.error` instead.
- The update prompt is the same in every app: when a new version is waiting, show a persistent pill "A new version is available" with Reload and × buttons. Reload first saves the draft (if the draft cannot be saved, it shows "Save your file first, then reload." and does nothing else), then sends `SKIP_WAITING` and reloads when the new worker takes control. It does not use `showToast`, so a later toast cannot replace it. The quoted English text is the reference: each app shows it in its own UI language. "The draft" is the IndexedDB copy, and × hides the pill until the next page load.

#### Wording and language

- Each app ships the UI languages that fit its users. The product's `AI_RULES.md` names them. Do not add or drop a language without asking.

  | App | UI languages | Users |
  | --- | --- | --- |
  | grind-cash | English, Japanese, German, French, Spanish, Italian | Overseas users |
  | grind-money | Japanese only | Japanese users |
  | grind-people | English, Japanese | |
  | grind-qrcoder | English only | Overseas users |

- An app with several languages keeps its strings in `lang/<code>.js`, applied by one `i18n.js` (the same file in every such app, today cash and people; fix it in one and copy it to the other). `data-i18n` sets text only; use `data-i18n-html` for a string that contains markup. The language follows `navigator.language` on first run and is then the user's choice, remembered in `localStorage` (`app_lang`). A single-language app keeps its strings inline, in that language, and needs no `lang/` folder or `i18n.js`.
- The same words are used for the same actions: Open / 開く, Save / 保存, Cancel / キャンセル, Delete / 削除, Undo / 元に戻す.

#### Files and build

- Every app opens its file by Open, drag and drop, and the manifest `file_handlers` entry with `launchQueue` (where the browser supports it), and saves with the File System Access API where available, with a download fallback.
- Every app has the same file-password flow: optional, at least 8 characters, NFC-normalized, `GRINDEN2`. A failed decryption (wrong password or damaged file; AES-GCM cannot tell them apart) shows one message that names both possibilities and lets the user retry without reloading.
- Every app builds `styles.css` with `./build.sh`, using one pinned Tailwind CSS version (4.3.1). The reference script is grind-qrcoder's `build.sh`, which downloads the standalone binary and checks its SHA-256. `./build.sh` is the entry point; any other script (such as cash's `npm run build`) must run the same command with the same Tailwind version. A `package.json` is optional and only for formatting tools.

### Code and language

- Identifiers, code, comments, console messages and Git commit messages in English.
- UI text follows the "Wording and language" rules in UI above. Other languages may appear only in UI strings (the `lang/` files, or inline in a single-language app) and in data the code must match or produce (for example full-width punctuation in a regex, or a built-in Japanese dictionary). A product's file may add rules, but never a language the shared rule excludes.
- Comments follow Grind rules §5. Apply this to code you add or change; do not churn existing comments only to comply.
- Before suggesting an optimization, follow the real data flow in the browser (component scope vs `window`, what is persisted and when).
