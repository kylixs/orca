# UI Prototype — Mobile File Actions

Canonical prototype: [`../../ui-prototypes/file-actions.html`](../../ui-prototypes/file-actions.html)

English UI copy inside the phone frames is normative. Chinese text on the page and in the design docs is explanatory commentary only.

## Action model

- One user-visible save action: **Save to phone**. There is no separate download action; prepare/write-to-cache is an internal phase.
- File menu order: **Preview** (when available), **Save to phone**, **Open with**, **Copy content**, **Copy path**, **Cancel**.
- Directory menu: **Copy path**, **Cancel** only. Tapping a directory expands/collapses it.
- No Orca browser action.
- Row ends expose a 44×44 `…` and long-press; both open the same ActionSheet. Releasing a long-press must not open preview.
- Android Save to phone uses SAF for files up to 16 MB and the system share sheet for 16–256 MB. Over 256 MB shows “File is too large; save it on desktop.” iOS Save to phone opens the share sheet with the **Save to Files** subtitle/label.
- Terminal artifacts render the header **Save** only for editable text with unsaved changes. Header Save writes the edit back to the artifact; images, read-only artifacts, and terminal text over 512 KB never render it.
- Terminal text over 512 KB is not truncated on mobile. It shows “Too large for mobile; open on desktop.”, and its action sheet is **Copy path**, **Cancel** only. Terminal images over ~3 MB show the same too-large hint.
- Copy content reads on demand (≤512 KB). Larger worktree text is truncated at 512 KB and the copied result notes the truncation.
- Terminal **Copy path** copies `pathText ?? displayPath`; worktree files copy their relative path.
- A failed row’s `…`/long-press menu is **Retry read**, **Copy path**, **Cancel** — not Preview. Retry success clears the badge; reconnect only clears connection/timeout failures.
- `file-save-result` is a real state: path + SHA-256 + “Cached copy kept for 24 hours”.

## States demonstrated

- 01 `file-tree` — interactive tree; tap previews, long-press or row-end `…` opens actions; no header More, no row size labels.
- 02 `file-filter` — Code filter; ancestor folders kept, loaded empty folders hidden, unloaded `legacy` kept with “not loaded”.
- 02b `file-filter-docs` — Docs filter; PDF belongs to Docs; unloaded folder preserved.
- 03 `file-sheet` — text action sheet in the fixed order, plus the long-press-released state (preview not opened).
- 04 `file-image` — image menu without Copy content.
- 05 `file-media` — media menu; Android >16 MB Save shows “Share sheet (>16 MB)”.
- 06 `file-pdf` — PDF/binary menu; Preview hidden, Save/Open/Copy path available.
- 07 `file-artifact-text` — editable terminal text with unsaved changes; header Save appears only in this dirty state, alongside the one overflow `…`; sheet Save to phone remains the only save-to-phone action.
- 07b `file-artifact-text-too-large` — terminal text over 512 KB; “Too large for mobile; open on desktop”; action sheet is Copy path + Cancel only; no header Save, Save to phone, Open with, or Copy content.
- 08 `file-artifact-image` — terminal image under ~3 MB; Save/Open available; no header Save (not editable).
- 08b `file-artifact-image-large` — terminal image over budget; “Too large for mobile; open on desktop”; Copy path only; no header Save.
- 09 `file-read-failure` — row badge appears only after a failed action; its menu is Retry read + Copy path + Cancel; Retry success clears the badge; reconnect only clears connection/timeout failures; no per-row stat.
- 10 `file-save-safe` — Android SAF directory picker for files up to 16 MB.
- 11 `file-save-result` — saved-result state in the same ActionSheet flow, with visible path, SHA-256 verification, and “Cached copy kept for 24 hours”.
- 12 `file-open-android` — Android ACTION_VIEW chooser; 24-hour cached-copy note and share-sheet fallback.
- 13 `file-open-ios` — iOS share sheet with Save to Files.
- 13b `file-sheet-ios` — iOS menu subtitle “Save to Files”.
- 14 `file-download-progress` — preview-side Save preparing progress and cancel (internal prepare, not a separate user action).
- 14b `file-list-download-progress` — list-side Save progress; the file list stays visible, the same progress banner shows Cancel, and repeated Save/Open taps stay disabled (single-flight).
- 15 `file-download-retry` — Save failure; retry starts from the beginning; no partial file.
- 16 `file-search` — results clicked to preview; row-end `…` opens the same action sheet; “Showing first 32 of 148 matches”; >20k warning.
- 16b `file-search-old-host` — old-host fallback: “Showing first 5000; results may be incomplete”; does not claim all files were searched.
- 17 `file-selection` — HTML rendered-view text selection with Copy / Select All.
- 18 `file-save-share-fallback` — Android >16 MB Save via system share sheet.
- 19 `file-save-error` — SAF cancel / revoked folder permission; no file written; temporary data removed.
- 20 `file-too-large` — >256 MB desktop hint; Save/Open disabled; Copy path only.
- 21 `file-single-flight` — one progress for Save/Open; duplicate actions disabled.
- 22 `file-cache-settings` — Settings cache clear state; cached copies kept for 24 hours; LRU 512 MB.

Theme tokens: `#111111` background, `#3b82f6` accent, `6px` radius. Touch targets are 44×44 or use hitSlop. All app overlays are bottom ActionSheets; system share/SAF sheets are shown in system light styling. Frames are 390×844.
