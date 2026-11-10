# Code review 02 — mobile terminal link sheet + CJK/wide selection

Scope: second-round review of the link-sheet and selection work on `feat/remote-terminal-load-diagnostics`, against `design.md` §7, `test-plan.md`, `tasks.md`, and `reviews/code-review-01.md`. Concurrent file-browser/HTML and remote-terminal-load-diagnostics changes were read only where they share the gate output (they are not reviewed here).

Date: 2026-11-10
Verdict: **APPROVE WITH MINORS — 0 BLOCKER / 0 MAJOR / 2 MINOR**

Review-01's BLOCKER and MAJOR are fixed, and five of the six MINORs are resolved for this feature. The one real issue still open is the legacy-migration lost update; the other is residual test-plan coverage (test-only). No new correctness defect was found in the fixes.

---

## Round-01 disposition

| ID | Status | Evidence |
|---|---|---|
| B1 Chrome-74 `.at` | **Fixed** | `text-tokenizer.ts:89,228,268` use `[length - 1]`; the built bundle contains no `.at(` (independently scanned); guard at `native-document-bundle.test.ts:325-343`; runtime arms delete `Array.prototype.at` at `text-tokenizer.test.ts:163-184` and `selection-range.test.ts:238-266`. |
| M1 trailing-slash atomics | **Fixed** | `text-tokenizer.ts:108-120` drops a slash span only when the whole span is separators (`^[.\\/]+$`), so HTTP/file matches are untouched. Vectors `https://example.com/`, `https://example.com/a/`, `/var/log/`, `/tmp/`, `C:\`, `./src/`, `file:///tmp/` are asserted both at token level (`text-tokenizer.test.ts:91-107,186-202`) and at copy level (`selection-range.test.ts:140-151`). `../` alone is still prose. |
| m1 unparseable URL summary | **Fixed** | `terminal-link-presentation.ts:98-105` returns `scheme:…` or `Unparseable URL`, never the raw value; zero-width Cf characters added to the sanitizer (`:19-24`). Tests: `terminal-link-presentation.test.ts:68-88`, `TerminalLinkActionSheet.test.tsx:183-197`. |
| m2 silent background refusals | **Fixed** | Every guard in `use-mobile-session-content-create-actions.ts:161-184` toasts and returns `false`; the RPC catch toasts (`:202-205`). The stored-mode direct path checks the boolean/rejection and opens the sheet (`use-mobile-session-file-actions.ts:184-203`); the sheet path toasts instead of returning silently. Tests: `use-mobile-session-content-create-actions.test.ts:101-139`, `use-mobile-session-file-actions.test.ts:232-251,386-393`. |
| m3 migration lost update | **OPEN** | See MINOR 1. |
| m4 duplicate handle-change effect | **Fixed** | The only choice-clearing effect is `use-mobile-session-file-actions.ts:136-140`; `use-mobile-session-screen-state.ts` now owns state only. A16 test at `use-mobile-session-file-actions.test.ts:355-372`. |
| m5 test coverage | **Mostly fixed** | A12 projection/reconnect (`use-mobile-session-content-create-actions.test.ts:141-175`), A16, A29 failure paths, and both-arm parity over 24 vectors (`text-tokenizer.test.ts:35-60,186-202`) are now covered. A21/A30b remain partially covered — see MINOR 2. |
| m6 changed-lines gate | **Fixed for this feature** | No remaining finding is in a link/selection file (see Verification). The gate is still red because of the concurrent file-browser/HTML and load-diagnostics files, which are out of scope here. |

---

## Remaining issues

### MINOR 1 — Legacy migration can still overwrite a v2 preference the user just saved

**Where:** `mobile/src/storage/preferences.ts:309-315` (read v2 at `:309`, write `ask` at `:311`), with the competing write at `:284-286`. `persistMirrored` (`mobile/src/storage/mirrored-storage-keys.ts:82-93`) performs each write independently; there is no per-key queue or compare-and-set, so the check-then-write in the migration is not atomic.

**Failure scenario:** The first sheet is shown immediately (`use-mobile-session-file-actions.ts:156`) while `consumeLegacyTerminalLinkOpenMode()` is still awaiting storage. On a cold/first-run store, the user can tap “Open on this phone” with Remember before the migration's second `getItem(v2)` resolves. `saveTerminalLinkOpenMode('phone-browser')` writes v2, then the migration's already-issued read answers `null` and `persistMirrored(v2, 'ask')` runs, reverting the user's just-saved choice. The next focus load reads `ask`, so the next link opens the sheet again and “Remember my choice” appears to have been ignored. The existing latch only prevents a second migration; it does not order the migration against `saveTerminalLinkOpenMode`.

**Fix:** Put both `saveTerminalLinkOpenMode` and the migration write behind one promise barrier for this key (same pattern as `saveDefaultSessionView` in `session-view-preferences.ts:13,52-63`), with the migration's read+write inside the barrier; or re-read/mark the version after the write and retry/abandon if a v2 write won the race. A test can defer the mock `setItem` and assert the remember-write survives a migration that started first.

### MINOR 2 — Residual test-plan coverage for A21 and the recovery half of A30b

**Where:** no test exercises the initial-`ask`-before-preference-load race (`use-mobile-session-screen-state.ts:46-47` initializes `ask`, and `use-mobile-session-preference-focus.ts:43-55` loads later), and no end-to-end test covers “stored `orca-browser` unavailable → sheet → capability recovers → next tap opens directly” (A30b). The pieces exist: `use-mobile-session-file-actions.test.ts:175-194` covers the unavailable fallback, and `terminal-link-open-policy.test.ts:85-98` covers both the available direct decision and the no-downgrade decision. This is a coverage gap, not an observed behavior defect.

**Fix (optional before merge):** assert that a render before `loadTerminalLinkOpenMode` resolves uses `ask` and never calls `browser.tabCreate`/`openExternalLink`; and drive the stored-mode path twice, first with `statusReadable: false` (sheet, no `saveTerminalLinkOpenMode`) then with the gate restored (direct `browser.tabCreate`, no sheet).

---

## Requested-item verification

- **Chrome 74 floor:** confirmed. The document/engine targets remain `chrome74`; the generated bundle has zero occurrences of `.at(`, `.findLast(`, `.findLastIndex(`, `.toSorted(`, `.toReversed(`, `.toSpliced(`, `.with(`, `Object.hasOwn`, `Object.groupBy`, `Map.groupBy`, `Promise.withResolvers`, `Array.fromAsync`, `structuredClone`, `.replaceAll(`, `.matchAll(`, `Promise.allSettled`, `.flat(`, `.flatMap(`, `WeakRef`, or `FinalizationRegistry`. The single `Object.fromEntries` use is Chrome 73, below the floor. Both static guard and runtime tokenizer/selection tests are present. Residual risk (not counted): the guard is a blocklist, so a future post-74 built-in not on the list would pass.
- **Trailing-slash atomics / G12–G13:** confirmed fixed; see M1 row above. G12b–G13b copy assertions compare the entire original string, so both the leading `/` and the trailing `/` are covered.
- **Unparseable URL userinfo / control chars:** confirmed; summary is scheme-only on parse failure, and the expanded view keeps userinfo only after bidi/control/zero-width filtering.
- **Background create refusals / direct-open boolean / A29:** confirmed. All refusal guards toast; the remembered direct path checks the returned boolean or rejection and falls back to the sheet; phone/copy/no-handler failures toast. A29 tests are present for the create, copy, and missing-handler paths.
- **Single handle-change owner / A16:** confirmed. One effect in `use-mobile-session-file-actions.ts:136-140` restores keyboard state and resets the in-flight latch; the screen-state duplicate is gone; the A16 test asserts sheet close and action suppression.
- **A12 projection/reconnect:** confirmed by `use-mobile-session-content-create-actions.test.ts:141-175`: `activate:false`, no pending focus page id, and the accepted snapshot replayed (reconnect) never calls `activateBrowserTab`.
- **Segmenter parity:** confirmed over the full vector list in both fallback arms (Segmenter absent, constructor throws), plus a `segment()` throw case; the Chromium-74 test deletes both `Intl.Segmenter` and `Array.prototype.at`.
- **Quality gate:** the feature is clean. `pnpm run check:code-quality:changed` still exits 1 with 17 findings, all in concurrent file-browser/HTML (`file-download-naming`, `use-mobile-file-search`, `mobile-html-preview-frame`, `MobileFileExplorerPanel`, etc.) or load-diagnostics (`mobile-terminal-diagnostics.test.ts`) files; none is in a link/selection file reviewed here.
- **Deferred legacy migration overwrite:** **still open**; see MINOR 1.

---

## Verification performed

- `pnpm --dir mobile vitest run src/terminal/document/text-tokenizer.test.ts src/terminal/document/selection-range.test.ts src/terminal/document/native-document-bundle.test.ts src/session/terminal-link-presentation.test.ts src/session/terminal-link-open-policy.test.ts src/session/TerminalLinkActionSheet.test.tsx src/session/use-mobile-session-file-actions.test.ts src/session/use-mobile-session-content-create-actions.test.ts src/storage/preferences.test.ts src/terminal/terminal-webview-tap-routing.test.ts` — 10 files / 201 tests pass.
- `pnpm --dir mobile typecheck` — passes.
- `pnpm tc:node` — passes.
- `pnpm vitest run src/main/runtime/runtime-extraction-regressions.test.ts` — 6/6 pass (including conditional broadcast of `browser.tab-create-background.v1` only when the host can browse).
- `pnpm run check:code-quality:changed` — fails on 17 findings, all in the concurrent work listed above; no link/selection finding.
- Independent scan of `mobile/src/terminal/terminal-webview-document-script.generated.ts` for post-Chrome-74 built-ins (results above); bundle guard test re-builds and compares the shipped string.

Not re-run this round: full `pnpm --dir mobile test`, test-typecheck, and device/old-WebView evidence. No device was exercised.
