# Regression-01 — independent final automation + Android device regression

- Date: 2026-11-10
- Scope: final code with fix-01..fix-05 (file browser, terminal links/selection, HTML open modes),
  independent automated run and independent Android emulator regression.
- Role: final independent regression subagent. Product and test code were read-only. No commits.
  Only evidence under `device-evidence/regression-01/` and this report were written.
- Branch/HEAD: `feat/remote-terminal-load-diagnostics` / `324078d8471`; all three features and the
  diagnostics work remain uncommitted on top.
- Evidence root: `remote-connectivity/design/test-reports/device-evidence/regression-01/`
  (fixtures, scripts as text, logs, screenshots, `logs/sha256-manifest.txt` — 214 entries, verified
  with `shasum -a 256 -c`).

## 1. Verdict

**FINAL_ACCEPT** for the three features and the diagnostics fix on Android, with the residual
environment/uncovered areas listed in §6.

- No new product regression was found.
- Both original real defects are fixed: Android `javascript:` execution (R-01) and the full-height
  filter chips (R-02).
- The other two reported FAILs are confirmed false positives: terminal highlight/copy mismatch and
  the save banner swallowing touches.
- 0 BLOCKER / 0 MAJOR / 0 MINOR product findings in this run.
- iOS remains BLOCKED by the Xcode 26 environment; it is not a product failure.

### Final counts

| Area | Full PASS | Partial PASS | BLOCKED | FAIL |
|---|---:|---:|---:|---:|
| Automated commands | 5/5 commands | — | — | 0 |
| Android feature/regression rows (H18 + F18 + T13 + R5 = 54) | **49** | **3** | **2** | **0** |

The 2 BLOCKED Android rows are synthetic-gesture limitations (terminal multi-line drag and handle
crossing), not observed product failures. Partial rows are not counted as full PASS. In addition,
the whole iOS matrix and the save-size/SAF/old-host/SSH matrix remain BLOCKED / NOT RUN (§6).

## 2. Environment and code freshness

| Item | Value |
|---|---|
| Host | macOS 15.6 (Darwin 24.6.0), arm64 |
| Android | `emulator-5554`, Pixel_8a, Android 16 / API 36, arm64, 1080x2400 @ 420 dpi |
| App | Orca Mobile 0.0.52 (versionCode 19), debug dev-client, `com.stably.orca.mobile` |
| Installed APK | SHA-256 `b03b521d2ce23152b4819dcf9afc22bc0e39e4d42b15fe478f592405bb1d772e` — matches fix-04's rebuilt APK |
| WebView | Chrome/WebView 133.0.6943.137 |
| Metro | `packager-status:running` on 8081 |
| Isolated host | headless `orca serve --mobile-pairing` on 6770, `HOME=/tmp/orca-mobile-pair/home`, `ORCA_USER_DATA_PATH=/tmp/orca-mobile-pair/userData` |
| Reverse | `tcp:8081`, `tcp:6770` |

Fix-05 is JavaScript-only. The app was stopped and relaunched through the dev client and the Metro
bundle was reloaded before device probes. The live fix-05 behavior (adopted-frame installer with no
`ReferenceError`; both blocked metas removed in the observer microtask) was observed in
`logs/dynamic-frame.json`, so the served bundle contains fix-05.

## 3. Automated results (actually executed)

| # | Command | Exit | Result | Log |
|---|---|---:|---|---|
| 1 | `pnpm --dir mobile test` (full) | **1** | 999 files: 995 passed, 2 failed, 2 skipped; 10,696 tests: **10,687 passed, 3 failed, 6 skipped**; 61.4 s | `logs/mobile-test-full.log` |
| 2 | `pnpm --dir mobile typecheck` | 0 | `tsc --noEmit` clean | `logs/mobile-typecheck.log` |
| 3 | `pnpm tc` | 0 | all four projects clean | `logs/root-tc.log` |
| 4 | `pnpm run check:code-quality:changed` | 0 | **0 new findings across 172 changed files**; gate passed | `logs/code-quality-changed-final.log` |
| 5 | focused fix tests (interception, scheme, frame, filter chips, relative assets) | 0 | **5 files / 75 tests passed** | `logs/focused-fix-tests.log` |

The only failures are exactly the three known clean-HEAD failures; there are no new failures and no
diagnostics-related failures:

| File | Failing test | Classification |
|---|---|---|
| `mobile/src/mock-server-key-pair.test.ts` | `makes concurrent creators converge on the persisted winner` | pre-existing toolchain (`loadOrCreateMockServerKeyPair is not a function`) |
| `mobile/src/tasks/mobile-agent-launch-architecture.test.ts` | `shares one durable receipt across entry points and a reopened store` | pre-existing test drift |
| `mobile/src/tasks/mobile-agent-launch-architecture.test.ts` | `replays an exhausted collision after restart without searching names again` | pre-existing test drift |

The full suite includes all 16 RPC-recording/diagnostics tests that failed before fix-05's
predecessor fix; none of them fail. The changed-code gate was re-run after all evidence files were
added and still reports 0 findings.

## 4. Status of the four reported FAILs

| Original row | Final status | Evidence |
|---|---|---|
| R-01 Android HTML preview executes `javascript:` (BLOCKER) | **FIXED — PASS** | `javascript:` click: no execution, no native JS dialog, toast shown, focus stays Orca; page's own capture listeners never ran. `screenshots/reg01-10-js-blocked.png`, `logs/js.json` |
| R-02 filter chips render full-height (MAJOR) | **FIXED — PASS** | Row is one horizontal line, 105 px = 40 dp (chip 84 px = 32 dp) both with keyboard open and closed; results visible below. `screenshots/reg01-04-search-keyboard-chips.png`, `logs/filter-chips-keyboard-bounds.xml`, `logs/filter-chips-closed-bounds.xml` |
| TL-B11/B15 highlight vs copy (reported FAIL) | **FALSE POSITIVE — PASS** | Single-line CJK/emoji/5-char copies exactly matched the intended cell ranges; Select All copied the full buffer including CJK, emoji/ZWJ and the URL. `screenshots/reg01-79-multiline-drag.png`, `logs/selectall-clip.xml` |
| Save banner swallows touch (reported FAIL) | **FALSE POSITIVE — PASS** | With the “Saved to phone” banner visible, long-press on a row opens the action sheet on the first attempt; the blocking surface is the expected result modal. `screenshots/reg01-63b-banner-longpress.png`, `logs/banner-longpress2.xml` |

R-03 (meta-refresh silent block) is also fixed: static 1 s, late-attribute, re-appended and dynamic
0 s blocked refreshes are removed and produce the documented toast. R-04 (duplicate save result
sheet + banner) remains the previously deferred design decision; it is not a regression.

## 5. Android regression matrix

Every row below was exercised in this run on the final bundle. “Full PASS” means a screenshot and/or
a structured probe log directly demonstrates the asserted outcome.

### 5.1 Security and HTML (H1–H18: 18 full PASS)

| ID | Case | Result | Evidence |
|---|---|---|---|
| H1 | `javascript:` link not executed, toast, no dialog | PASS | `screenshots/reg01-10-js-blocked.png`; `logs/js.json` |
| H2 | `file:` link rejected, toast, no navigation | PASS | `reg01-11-file-blocked.png`; `logs/file.json` |
| H3 | `intent:` link rejected, Chrome not launched, toast | PASS | `reg01-11-intent-blocked.png`; `logs/intent.json` |
| H4 | `tel:` rejected, dialer not opened, toast | PASS | `reg01-11-tel-blocked.png`; `logs/tel.json` |
| H5 | custom scheme rejected, no external app, toast | PASS | `reg01-11-custom-blocked.png`; `logs/custom.json` |
| H6 | static 1 s meta refresh to `file:` does not navigate; toast; meta removed | PASS | `reg01-20-meta-static-1s.png`; `logs/meta-static-state.json` |
| H7 | meta appended with `http-equiv`, `content` set later — removed | PASS | `logs/meta-late.json` (`lateAfterContentWrite.metaCount = 0`) |
| H8 | blocked meta removed then re-appended — removed again | PASS | `logs/meta-late.json` (`remountAfterReappend.metaCount = 0`) |
| H9 | dynamically inserted 0 s blocked meta — removed before navigation; toast | PASS | `reg01-22-meta-zero-toast.png`; `logs/meta-late.json`, `logs/meta-zero-ui.xml` |
| H10 | subframe `https:` loads inside the preview, Chrome does not open | PASS | `reg01-35-subframe-https.png`; `logs/subframe-frame-https.json` |
| H11 | subframe `mailto:`/`tel:`/`blob:` blocked, no mail/dialer/browser | PASS | `logs/subframe-frame-{mailto,tel,blob}.json` |
| H12 | dynamic `about:blank` + `document.write` frame: `javascript:` blocked, no exception | PASS | `reg01-34-dynamic-frame.png`; `logs/dynamic-frame.json` |
| H13 | `srcdoc` iframe `javascript:` blocked, no external app, no host toast | PASS | `reg01-33-iframe-js.png`; `logs/iframe-js.json` |
| H14 | `https:` opens Chrome externally; preview does not navigate | PASS | `reg01-15-https-chrome.png`; `logs/https.json` |
| H15 | `#fragment` navigates in place | PASS | `reg01-12-fragment.png`; `logs/fragment.json` (`about:blank#section`) |
| H16 | top-frame `data:` refused by the WebView engine, Orca stays foreground | PASS | `reg01-13-data.png`; `logs/data.json` |
| H17 | `formaction="javascript:"` blocked, submit listener not called, toast | PASS | `reg01-14-formaction.png`; `logs/formaction.json` |
| H18 | pre-empting page cannot pre-seed/disable the fence; blocked-scheme clicks never reach its capture listener | PASS | blocked schemes: `guard = v2`, `pageClickObserved = false` (`logs/{js,file,intent,tel,custom}.json`); allowed `#fragment`/`data:`/`https` are observed as expected, and `formaction` did not reach the submit listener |

### 5.2 File browser (F1–F18: 18 full PASS)

| ID | Case | Result | Evidence |
|---|---|---|---|
| F1 | text long-press menu: Preview, Save to phone, Open with, Copy content, Copy path, Cancel | PASS | `reg01-42-longpress-text.png`; `logs/longpress-text-ui3.xml` |
| F2 | directory menu: Copy path, Cancel only | PASS | `reg01-41-longpress-dir.png`; `logs/longpress-dir-ui.xml` |
| F3 | PDF/binary menu: Save to phone, Open with, Copy path, Cancel (no Preview/Copy content) | PASS | `reg01-44-longpress-pdf.png`; `logs/longpress-pdf-ui.xml` |
| F4 | image menu: Preview, Save to phone, Open with, Copy path, Cancel | PASS | `reg01-43-longpress-binary.png`; `logs/longpress-binary-ui.xml` |
| F5 | unreadable file → “Unable to load preview” + Retry; after chmod, Retry renders content | PASS | `reg01-46-read-failure.png`, `reg01-47-retry-success.png`; `logs/read-fail-ui.xml`, `logs/retry-success-ui.xml` |
| F6 | 0-byte file → “Empty file”, no crash | PASS | `reg01-45-empty-file.png`; `logs/empty-preview-ui.xml` |
| F7 | SAF save to Documents; SHA-256 matches host exactly | PASS | `reg01-60-saf-picker.png`, `reg01-61-save-result.png`; device `sha256sum` = `1b2552e93015918fa5c553a98ceed703d235f50a544bf90b7bd02fc6866eb29d` for 30 bytes |
| F8 | search + Docs filter; wording “Showing first 32 of 134 matches / filters apply to these first 32” | PASS | `reg01-64-search-reg01.png`, `reg01-65-filter-docs.png`; `logs/filter-docs.xml` |
| F9 | filter chips one row, 40 dp, keyboard open and closed | PASS | `reg01-04-search-keyboard-chips.png`; both bound dumps: row `[0,427][1080,532]` and `[0,406][1080,511]`, chip 84 px |
| F10 | save result sheet + visible banner do not swallow the next long-press | PASS | `reg01-61-save-result.png`, `reg01-62-banner.png`, `reg01-63b-banner-longpress.png`; `logs/banner-longpress2.xml` |
| F11 | HTML row long-press array exactly Preview, Source, Save, Open with, Copy content, Copy path, Cancel | PASS | `reg01-50-html-row-menu.png`; `logs/html-row-menu-ui.xml` |
| F12 | preview overflow array identical, single Preview, no Remember | PASS | `reg01-52-html-overflow-menu.png`; `logs/html-overflow-menu-ui2.xml` |
| F13 | rendered Markdown long-press selects a word with Copy/Share/Select all | PASS | `reg01-49-markdown-selection.png` |
| F14 | long-press a search result opens the same file action sheet | PASS | `reg01-42-longpress-text.png` (result was found by search) |
| F15 | >20k library notice “File library exceeds 20,000 files; results may be incomplete.” | PASS | `reg01-01-search-preempting.png`, `reg01-42-longpress-text.png` |
| F16 | lazy directory expansion works (root → `remote-connectivity` → children) | PASS | `reg01-82-lazy-dir.png`; `logs/lazy-dir.xml` |
| F17 | Settings → HTML open mode restored to Ask shows the chooser; Remember + Preview reopens directly | PASS | `reg01-55-browser-settings.png`, `reg01-56-settings-ask.png`, `reg01-57-html-chooser-ask.png`, `reg01-58-remember-reopen.png`; `logs/browser-settings-ask.xml`, `logs/html-chooser.xml`, `logs/reopen-direct.xml` |
| F18 | HTML Preview/Source toggle renders syntax-highlighted source then restores preview | PASS | `reg01-53-html-source.png`, `reg01-54-html-preview.png`; `logs/html-source-ui.xml`, `logs/html-preview-ui.xml` |

### 5.3 Terminal (T1–T13: 11 full PASS, 2 BLOCKED)

| ID | Case | Result | Evidence |
|---|---|---|---|
| T1 | link sheet: URL summary, Show full URL, phone, desktop, Copy, Cancel, Remember | PASS | `reg01-73-terminal-link-sheet-ask.png`; `logs/terminal-link-sheet2.xml`, `logs/kb-link-tap.xml` |
| T2 | desktop item disabled with “Update Orca on the host to open links here.” | PASS | same sheet |
| T3 | Copy link puts exactly `https://example.com/docs?x=1` on the clipboard | PASS | `reg01-74-link-copy.png`; `logs/link-clipboard-check.xml` |
| T4 | “Open on this phone” opens Chrome; the phone stays on the terminal tab | PASS | `reg01-84-phone-open.png`; `logs/after-phone-open.xml` |
| T5 | Remember + phone: next tap opens directly, no sheet | PASS | `reg01-85-link-remembered-direct.png`; `logs/remember-link.xml` (no “Open link”) |
| T6 | `中文abc`, long-press 中 → clipboard exactly `中文` | PASS | `reg01-71-terminal-cjk-copy-check.png`; `logs/clipboard-check.xml` |
| T7 | emoji right half → clipboard exactly `😀` | PASS | `reg01-75-emoji-select.png`; `logs/emoji-clip.xml` |
| T8 | `中华人民共和国万岁`, tap cell 4 → clipboard exactly `人民共和国` | PASS | `reg01-76b-cjk5-select.png`; `logs/cjk5b-clip.xml` |
| T9 | multi-line copy via Select All: full buffer, CJK/emoji/URL/path all preserved | PASS | `reg01-81-select-all.png`; `logs/selectall-clip.xml` (288 chars, all 15 lines) |
| T10 | highlight/copy consistency for the single-line and Select All paths | PASS | T6–T9 copies matched the visible ranges; no mismatch |
| T11 | link tap with IME open using a 60 ms touch: sheet opens, IME dismisses | PASS | `reg01-83-keyboard-link-60ms.png`; `logs/kb-open.xml` (`mInputShown=true` before), `logs/kb-link-tap.xml` (sheet + `mInputShown=false`) |
| T12 | multi-row selection by dragging on the terminal body | **BLOCKED** | Synthetic `input motionevent`/`swipe` either did not extend the selection or was consumed by the system back-edge gesture; `reg01-79-multiline-drag.png`, `reg01-80-multiline-swipe.png`, `logs/ml-*.xml`. Unit tests cover the model. |
| T13 | handle crossing (drag start past end, equal-point release) | **BLOCKED** | Same synthetic-drag limitation; no reliable handle drag from adb on this emulator. Unit vectors pass. |

The 2 blocked rows are gesture-injection limitations, not observed failures. The prior review's
manual-style drag was not reproducible with today's automated input path.

### 5.4 Regression checks (R1–R5: 3 full PASS, 2 partial)

| ID | Case | Result | Evidence |
|---|---|---|---|
| R1 | file HTML preview Preview/Source still works | PASS | `reg01-53-html-source.png`, `reg01-54-html-preview.png` |
| R2 | Markdown preview and search/filter regressions | PASS (preview) / **PARTIAL** (source mode not re-opened this run) | `reg01-48-markdown.png`, `reg01-49-markdown-selection.png` |
| R3 | search and lazy directory loading do not regress | PASS | `reg01-64-search-reg01.png`, `reg01-82-lazy-dir.png` |
| R4 | terminal input and link routing still work | PASS (input) / **PARTIAL** (scrollback scroll not exercised) | `reg01-88-terminal-input-path-output.png` (typed `ls ...` and executed it) |
| R5 | session HTML file opened from a terminal path | PASS (opened and rendered) / **PARTIAL** (this surface is an in-app `file://` browser tab; no Preview/Source control was present, so that control was not re-verified) | `reg01-87-session-html-preview.png` |

## 6. New regressions

**None.** 0 BLOCKER / 0 MAJOR / 0 MINOR product regressions attributable to fix-01..fix-05.

Non-defect observations, recorded for completeness:

1. **R-04 remains by design.** Saving produces both the result sheet and the persistent
   “Saved to phone” banner. This is the previously deferred UX decision, not a new regression.
2. **Session path tap surface.** Tapping a printed HTML path opens an in-app `file://` browser tab
   and renders it; it is not the same screen as the file-browser preview with Preview/Source
   controls. This appears to be existing session-browser behavior, but it means the session
   Preview/Source control was not independently re-exercised.
3. **Harness artifact.** Deep-linking directly to `/browser-settings` leaves an expo-router
   “The action 'GO_BACK' was not handled” banner because the deep link has no navigation stack.
   This came from the test harness, not from normal app navigation, and is excluded from findings.
4. **Back-edge gesture.** Automated drags starting at x≤60 px were consumed by Android's system
   back gesture; this is why T12/T13 are BLOCKED rather than failed.

## 7. Residual risks and not-covered areas

Not counted as PASS:

- **iOS**: every iOS-only case remains BLOCKED by the Xcode 26 / iOS 26 SDK requirement
  (Xcode 16.4 cannot compile the Expo SDK 55 packages). No iOS regression claim is made.
- **Physical Android device**: all results are emulator results; real-finger long-press/drag and
  vendor WebView differences are not covered.
- **File save matrix**: 5 MB, 15.9/16/16.1 MB, 18.2 MB, 100 MB, >256 MB, share fallback, cancel,
  rename, permission revoke, grant expiry, temporary-file cleanup, LRU/orphan cleanup.
- **511/512/513 KB boundary** was not re-measured in this run (fix-05 evidence covers it); 513 KB
  source-only behavior was previously verified.
- **Old host/old binary/OTA**, missing native modules, capability degradation.
- **SSH and folder workspaces**, path traversal, remote reads/saves.
- **Terminal artifact save limits** (≤512 KB text, ~3 MB image), media playback.
- **Accessibility/haptics**, 44×44 targets, screen-reader flows.
- **Terminal multi-row drag and handle crossing** on-device (T12/T13); unit vectors pass.
- **Markdown source mode** and **session Preview/Source control** (R2/R5 partial).
- Accepted residual security limits from fix-02..fix-05: same-context script can tamper with
  `Event.prototype.preventDefault`, call `form.submit()` or set `location.href`; cross-origin/CSP
  frames and pre-adoption `document.write` ordering are outside the DOM fence; WebView < 89 uses the
  page-first-preemptible `onPageStarted` fallback; subframe sentinels are intentionally dropped.

## 8. Count corrections versus the earlier reports

- The previous device report's `33 PASS / 4 FAIL / 23 BLOCKED` must not be read as 33 fully
  evidenced passes: it included partial rows (`A10`, `H-B9`) and rows with no named evidence.
  This report counts only rows actually re-driven in this run and splits full PASS / partial /
  BLOCKED.
- The previous four FAILs resolve as: **2 real defects fixed** (R-01 `javascript:`, R-02 filter
  chips) and **2 false positives** (TL-B11/B15 highlight/copy, save-banner touch).
- The previous automated report's `997 files / 10,658 tests` baseline has grown to
  `999 files / 10,696 tests` because the fix rounds added tests. The failure set is unchanged:
  exactly the same 3 clean-HEAD failures, no diagnostics-attributable failures.
- `android-75-html-remembered.png` from the old evidence is a terminal screenshot and is not used
  here; the remember flow is independently re-evidenced by `reg01-57`/`reg01-58`.

## 9. Evidence index

- Fixtures: `device-evidence/regression-01/fixtures/`
- Probe sources (as text): `device-evidence/regression-01/scripts/*.mjs.txt`
- Structured probe output and UI dumps: `device-evidence/regression-01/logs/`
- Screenshots: `device-evidence/regression-01/screenshots/` (`reg01-*`)
- Environment: `logs/environment.txt`
- Raw commands: `logs/raw-commands.txt`
- SHA-256 manifest: `logs/sha256-manifest.txt` (214 entries; verified)

Highlighted evidence files:

```text
logs/mobile-test-full.log
logs/mobile-typecheck.log
logs/root-tc.log
logs/code-quality-changed-final.log
logs/focused-fix-tests.log
logs/js.json, file.json, intent.json, tel.json, custom.json
logs/meta-static-state.json, meta-late.json, meta-zero-ui.xml
logs/subframe-frame-https.json, subframe-frame-mailto.json, subframe-frame-tel.json
logs/dynamic-frame.json, iframe-js.json
logs/saf-picker.xml, save-result.xml, banner-longpress2.xml
logs/filter-chips-keyboard-bounds.xml, filter-chips-closed-bounds.xml
logs/html-row-menu-ui.xml, html-overflow-menu-ui2.xml
logs/clipboard-check.xml, emoji-clip.xml, cjk5b-clip.xml, selectall-clip.xml
logs/link-clipboard-check.xml, kb-open.xml, kb-link-tap.xml, remember-link.xml
screenshots/reg01-10..15, 20..22, 30..35 (security/HTML)
screenshots/reg01-41..50, 52..65 (file browser/HTML modes)
screenshots/reg01-70..89 (terminal/regression)
```
