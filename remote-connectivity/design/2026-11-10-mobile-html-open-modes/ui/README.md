# UI Prototype — Mobile HTML Open Modes

Canonical prototype: [`../../ui-prototypes/html-open-modes.html`](../../ui-prototypes/html-open-modes.html)

English UI copy inside the phone frames is normative. Chinese text on the page and in the design docs is explanatory commentary only.

Revised against design section 8 (review 03). The prototype has no header “More” buttons in file-list states, no file-size labels on directory rows, no prefbar “Reset to Ask every time”, and no missing-asset placeholders or “Link blocked” popup. Blocked schemes use the in-frame toast “This link type isn't supported in preview”, emitted by `onBlockedScheme` for top-frame navigations only; iframes render in place and do not open the external browser. The single preview overflow “…” opens the same ActionSheet in every preview state. Its action order is Preview, Source, Save to phone, Open with, Copy content, Copy path, Cancel; unavailable actions are hidden. HTML uses the mode Preview, which replaces the generic file Preview, so there is never a second Preview. The auto chooser contains only Preview, Source, and Cancel, plus the “Remember my choice” switch; it never lists external actions. Long-press menus show the same order, never show a remember switch, and do not write a preference. Browser settings uses the existing row + PickerModal pattern: an “HTML open mode” row displays the current value and opens a select sheet offering Ask / Preview / Source; Ask remains the only Reset-to-Ask path.

## States demonstrated

1. First tap / Ask — auto chooser with only Preview and Source, plus Cancel and “Remember my choice”; remember applies to those two modes only.
2. Rendered view — the exact relative-asset warning lists the actual detected refs; the overflow opens the shared ActionSheet with the full order.
3. Preview overflow — the single overflow entry and the full shared action order, with exactly one Preview.
4. Source view — remembered Source; no reset control in the page or menus (Browser settings only).
5. File over 512 KB — fixed English copy, Preview disabled with `aria-disabled`, source note “Showing first 512 KB”; the shared ActionSheet is Source, Save to phone, Open with, Copy content (“Copies the first 512 KB”), Copy path, Cancel, with no Preview. 511 / 512 KB render; 513 KB and above are truncated.
6. Read failure — Retry only in the error panel; the shared ActionSheet is Retry, Save to phone, Open with, Copy path, Cancel, with no Preview, Source, or Copy content.
7. No app available — the capability probe covers native modules, not per-MIME handlers, so Open with stays visible until the system open fails. If it fails and no share fallback exists, the no-app toast uses the normative copy below; the shared ActionSheet is Preview, Source, Save to phone, Open with, Copy content, Copy path, Cancel.
8. Blocked scheme — `file:`, `intent:`, `javascript:`, and custom schemes are rejected with the in-frame toast from `onBlockedScheme` (top-frame only); iframes render without opening the external browser.
9. Long-press file menu — same actions and order as the overflow, exactly one Preview, no remember switch; selecting Preview or Source does not save a preference.
10. Browser settings — “HTML open mode” row with current value Ask and a PickerModal offering Ask / Preview / Source; the only Reset-to-Ask path.

## Normative English copy

- Relative-asset warning: “Relative assets may not load: … . Detected from src / href / url() in this file.” Replace “…” with up to three detected refs; omit the warning when no relative refs are detected.
- File over 512 KB: “File is larger than 512 KB. Rendering is unavailable; open the source or use desktop Orca.”
- Truncated source: “Showing first 512 KB”
- Truncated Copy content: “Copies the first 512 KB”
- Blocked scheme toast: “This link type isn't supported in preview”
- No available app toast: “No app available for this file type. Use Save to phone instead.”
- Shared action labels, in order: Preview, Source, Save to phone, Open with, Copy content, Copy path, Cancel
- Over-512-KB shared actions, in order: Source, Save to phone, Open with, Copy content, Copy path, Cancel
- Read-failure shared actions, in order: Retry, Save to phone, Open with, Copy path, Cancel
- Auto chooser: Preview, Source, Cancel (plus the “Remember my choice” switch)
- Settings: “HTML open mode” row showing the current value; PickerModal options Ask / Preview / Source

Theme tokens: `#111111` background, `#3b82f6` accent, `6px` radius. Touch targets are 44×44 or use hitSlop. Preview/Source lives in the second-row toolbar, not the header. There is no “Open in Orca browser” action and no “Ask every time” reset in any menu.
