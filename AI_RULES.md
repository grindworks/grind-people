# GrindPeople AI Rules

> Product type: PWA. Shared rules: [`../AGENTS.md`](../AGENTS.md) §1, §2, §4, §6 and the PWA rules in §7. This file adds GrindPeople (PWA) rules and wins where the two differ.
> The `.people` file (SQLite, optional `GRINDEN2` encryption) is also read and written by `../grind-people-mac`, and the two must stay byte-compatible. Check `../grind-people-mac/docs/people-file-format.md` before changing the schema, the format or the encryption (this includes the file password feature).

## 1. Stack

- Vanilla JavaScript, no frontend framework.
- Wasm SQLite (`sql.js`): the database lives in memory. Manage memory explicitly (`stmt.free()`, `db.close()` before re-instantiating) to prevent leaks.
- Tailwind CSS v4.2.4 via `./build.sh`, which runs `./tailwindcss-macos-arm64`. The binary is git-ignored; place it manually.

## 2. Data and files

- Files: `.people` (the database), plus `.vcf` and `.csv` import/export.
- SQL: ALWAYS use parameterized queries (`db.prepare("... WHERE id = ?")`). Never interpolate variables into SQL strings.
- `sql.js` does not auto-persist. Every INSERT, UPDATE or DELETE must call `setDirty(true)` so the user is warned before closing the tab.
- IndexedDB (`GrindPeopleDB`) holds only the auto-draft of the database (`saveDraft()` on `draftTimer`).

## 3. UI

- Look, top bar, shortcuts, toasts, dialogs, wording and languages follow shared §7 UI. Do not restate them here; add only what differs.
- Product-specific top-bar controls: the Settings button, placed before the file password field. The Settings dialog must not hold a theme choice (light only).
- UI languages: English and Japanese, in `lang/`, applied by `i18n.js` (shared with grind-cash, the other app with several languages).

## 4. Known gaps against shared §7

- `sw.js` has an inline offline fallback page with Japanese text.
- Warning and error toasts use red backgrounds; the shared rule keeps the pill dark for every type.
- Toasts appear at the bottom and stack up to 3; the shared rule is one pill at the top center. The update toast sits at `bottom-24` to clear them; move it to `bottom-6` when the toasts move.
- Tailwind is 4.2.4 through a git-ignored `./tailwindcss-macos-arm64` binary; move to 4.3.1 with the pinned-binary `build.sh` from grind-qrcoder.
- Japanese outside `lang/`: a console message in `main.js`, fallback text in `index.html`, comments in `input.css` and `.gitignore`.
