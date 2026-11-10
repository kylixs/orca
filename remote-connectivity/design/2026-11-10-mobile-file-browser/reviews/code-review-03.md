# Code review 03 — mobile file browser (after code-review-02 fixes)

Scope: third-round, read-only review of the file-browser work on `feat/remote-terminal-load-diagnostics`. Verified `reviews/code-review-02.md` B1 and m1–m5 against `design.md`, `test-plan.md`, `tasks.md`, the current tree, and the re-recorded goldens. Concurrent mobile HTML / terminal-link / remote-terminal-diagnostics work was only read where it shares files or gate output.

Date: 2026-11-10

Verdict: **APPROVED — 0 BLOCKER / 0 MAJOR / 3 MINOR**

The review-02 BLOCKER is fixed. All file-browser recordings replay, and the golden re-record changed only rendered screen-state values, not any recorded RPC frame. The three MINORs are cleanup/UX edges, not merge blockers.

---

## Round-02 disposition

| ID | Status | Evidence |
|---|---|---|
| **B1** — `Switch` crash in RPC recording harness | **Fixed** | `mobile/src/test-support/rpc-recording/screen-native-substitutes.ts:91,98-103` adds inert `ScrollView` + `Switch` and an `InteractionManager`; the panel mounts and sends `files.readDir`. No golden contains a `Switch` element, so the substitute is inert and did not change element counts. |
| **m1** — extensionless/unknown text lost Copy content in preview | **Fixed** | `mobile/src/files/mobile-file-target-kind.ts:32-34` now classifies from `getMobileFileKind`; `mobile-file-preview-action-target.test.ts:36-44` covers `LICENSE`, `Makefile`, `foo.log`, `.env`, `conf/app.conf` and asserts `previewable: true` + Copy content. PDF/zip stay binary (`:27-33`, `:47-50`). |
| **m2** — partial capability degradation was silent | **Fixed** | `mobile/src/files/mobile-file-actions.ts:204-209` returns the update notice whenever either action is missing; `mobile-file-actions.test.ts:224-241` covers both partial directions and both-missing. |
| **m3** — dead code | **Fixed** | Task `version` counter removed (`mobile-file-action-tasks.ts` has no `getFileActionTasksVersion`/version); `libraryTotalCount` removed from `use-mobile-file-search.ts`; unreachable `kind === 'shared'` branch removed and `SavedPreparedFileResult` narrowed to the `saved` arm (`mobile/src/files/mobile-file-save.ts:18-19`). Share dismissal still shows the non-deterministic notice and no result sheet (`use-mobile-file-actions.test.tsx:163-175`). |
| **m4** — hardcoded search limits / unused note input | **Fixed** | `MobileFileSearchResults.tsx:15-16,99,112` derives `32`/`5000` from `FILE_SEARCH_RESULT_LIMIT`/`LEGACY_FILE_LIST_LIMIT`; `MobileFileSearchNoteInput` no longer declares `truncated` (`:78-81`); the 20k cap moved to `src/shared/runtime-file-contracts.ts:4` and is re-exported from the main module, so both sides use one value. |
| **m5** — cache-clear / LRU invalidation tests | **Fixed** | `mobile-file-action-tasks.test.ts:153-187` drives the real `clearDownloadCache()` and `enforceDownloadCacheLimit()` and asserts one ready task becomes `idle`, the other survives. Not a listener-only test. |

---

## Requested verification

### B1 / recordings

- `mounted-screen-tree.test.ts`: **5/5 pass**.
- Files-explorer subset of `pilot-recordings.test.ts` + `family-recordings.test.ts`: **20/20 pass**.
- Files-explorer subset of `rpc-recording-through-bridge.test.ts` (parity): **20/20 pass**.
- Golden integrity / substitute suites (`screen-native-substitutes`, `native-mounting-substitutes`, `golden-recorder-failure-absence`, `derived-goldens`): **21/21 pass**.
- Golden re-record check against `HEAD`: for all four explorer goldens, every checkpoint/sender/payload/settlement value is **byte-identical**; checkpoint counts and effect counts are unchanged (2/2 and 12/12). Only the rendered `state` values changed, and they changed exactly by adding the search field/filter chips that the panel already renders (`ScrollView`, `Search`, `TextInput`, extra `Pressable`/`Text`) while preserving every row and every error state (`outer refused`, `Unknown method`, `transport failure`, unreadable reply, `No files found`). The old goldens predated that UI, so a bytes-identical re-record was not possible; the RPC-observable behaviour is unchanged.
- Full four-file recording run: **3 files failed / 1 passed, 16/1599 cases failed**. All 16 are `sc-reveal-first-poll`, `session-tab-activation-*`, and `matrix-session.tab-*` (`terminal.focus#1` / `session.tabs.activate#1` not sent). No `files.explorer-screen` or `matrix-files.*` case fails. This is the same unrelated session/terminal set review-02 already classified as concurrent work; it is not caused by this feature or its substitutes. It still has to be cleared by its owner before the branch is green.

### m1 classification parity

The client and host tables agree for every non-media extension: `file-tree.ts:45-61` = server `MOBILE_BINARY_EXTENSIONS` for all non-media entries (`.pdf`, `.zip`, images, `.mov`, `.mp3`, `.mp4`, …). Media extensions that the server calls `text` are caught first by `mobileFileMediaMime` and become `media` on both the list (`MobileFileExplorerPanel.tsx:158-161`) and the preview (`mobile-file-target-kind.ts:18-20`), so list and preview agree. Extensionless and unknown extensions are text on both sides.

### m4 20k contract

The wire field is additive/optional (`libraryTruncated?`), emitted by the host for both `files.list` and `files.searchPaths` (`runtime-file-commands-constructor.ts:80,131`), preserved by the mobile reader, and inferred for older hosts (`use-mobile-file-search.ts:225-228`). Old clients ignore the field, so mixed versions are safe.

---

## MINOR

### 1. Capability notice also fires when the target never had the hidden action

`mobile/src/files/mobile-file-actions.ts:204-209` + `mobile/src/files/MobileFileActionSheet.tsx:68-69`

The notice is computed from capabilities alone and shown in every sheet. Scenario: an Android host with SAF but no `ExpoSharing`/`ExpoIntentLauncher` (`{ saveToPhone: true, openWith: false }`). Long-press a directory or open the sheet for a >512 KB terminal artifact — `buildFileActions` returns only Copy path/Cancel, so nothing was hidden, yet the sheet says “Update Orca on this device to use file actions.” Consider deriving the notice from the built action ids (has `save`/`open`) instead of raw capabilities. Cosmetic; no action is lost.

### 2. Comment claims office/media containers are known-binary

`mobile/src/files/mobile-file-target-kind.ts:27-31`

The comment says “only a known-binary extension (PDF, zip, office/media containers) loses Preview and Copy content”, but `file-tree.ts:45-61` contains no office extensions; `.docx`/`.xlsx` are text on both client and host and keep Copy content. The behaviour matches the list; only the comment is misleading. Media is likewise handled by the `media` row, not the binary row.

### 3. New host wire field has no host-side assertion

`src/main/runtime/runtime-file-commands-constructor.ts:80,131`

Mobile tests cover reading/inferring `libraryTruncated`, but no main-runtime test asserts that `listMobileFiles` and `searchMobileFilePaths` actually emit it (the existing `files-path-search.test.ts` mocks the runtime method). Low risk — both are direct assignments from an already-tested `truncated`/`inventory.truncated` — but a host test would pin the contract.

---

## Regression checks (all green)

- **Action arrays**: `mobile-file-actions.test.ts`, `MobileFilePreviewScreen.actions.test.tsx`, `MobileFileExplorerPanel.test.ts` (text/markdown/HTML, image/media, PDF/binary, directory, terminal text/image/over-limit, readFailed, preview omits Preview, HTML Preview/Source exactly once).
- **Search notes**: `MobileFileSearchResults.test.ts` (32/new host, filter-only-touches-first-32, 5000 legacy, real legacy match total, 20k library cap, plain count); `use-mobile-file-search.test.ts` (cache/offline race, >32 totals, library truncation).
- **Save-result/share notice**: `use-mobile-file-actions.test.tsx` (saved → result sheet; shared → no result sheet, “Shared. Check your Files app…”); `mobile-file-save.test.ts` (SF boundaries).
- **HTML compatibility**: HTML open-mode and overlay suites inside `src/files` pass, including the concurrent HTML changes touched at the shared boundaries.
- **Typecheck**: `pnpm --dir mobile typecheck` and `pnpm tc:node` both exit 0.
- **Quality gate**: `pnpm run check:code-quality:changed` reports **0 new findings** for this feature. The only 3 findings are the existing concurrent `mobile/src/session/mobile-terminal-diagnostics.test.ts:67,80,92` assertions, unrelated to this work.

## Merge recommendation

No changes required for this feature. If only MINOR 1 is touched, keep it isolated (notice computation from the built actions). The branch is not globally green because of the 16 session/tab recording failures; those belong to the concurrent terminal work and must be cleared there, not by re-recording the file goldens.
