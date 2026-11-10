# Independent Test Review — Mobile File Browser, Terminal Links/Selection, HTML Open Modes

- Date: 2026-11-10
- Reviewer scope: audit of the two test reports, independent Android emulator reproduction, exploratory testing, and re-check of selected BLOCKED cases.
- Inputs: `automated-2026-11-10.md`, `device-2026-11-10.md`, all evidence under `device-evidence/`, the three feature design/test plans, and the code-review reports.
- Environment used: AVD `Pixel_8a` (Android 16 / API 36, arm64), Orca Mobile 0.0.52 debug dev-client, Chrome/WebView 133, isolated headless Orca host on port 6770, Metro dev bundle. iOS: Xcode 16.4 (16F6), Swift 6.1.2, iPhone 16/iOS 18.6 simulator booted with no app installed.
- Product code was read-only. No code or test file was modified. Only this report was written.

## 1. Verdict

**CHANGES_REQUIRED.**

The Android HTML preview still executes `javascript:` links. That is a security-boundary failure against the explicit scheme policy and is a release blocker. The file-browser filter chips still render as full-height columns and bury the results; that is a major layout defect. Two of the four reported FAILs do not reproduce and are not product defects. The iOS blocker is a real environment blocker, not a product failure.

| Measure | Count |
|---|---:|
| Reported device PASS / FAIL / grouped BLOCKED | 33 / 4 / 23 |
| Reported FAILs independently confirmed as product defects | **2** (1 BLOCKER, 1 MAJOR) |
| Reported FAILs shown not to be product defects | **2** (terminal highlight/copy; save-notice touch) |
| Additional product MINOR findings | 1 (missing blocked-scheme feedback on meta-refresh) |
| Environment blockers confirmed | 1 (iOS requires Xcode 26 / iOS 26 SDK) |
| Automated failures correctly classified | 3/3 pre-existing; 16/16 diagnostics-attributable and resolved; 3/3 quality-gate findings resolved |
| Reported PASS rows that are partial or have no named evidence | at least 9 of 33 (see §2.1) |

Top product issues:

1. **BLOCKER — Android HTML preview executes `javascript:` links** (`javascript:alert(1)` shows a native JavaScript dialog). Expected: reject the scheme and show “This link type isn't supported in preview”.
2. **MAJOR — File filter chips render as full-height vertical columns** and occupy most of the screen, especially with the keyboard open.
3. **MINOR — Non-whitelisted navigation via `<meta http-equiv="refresh">` is blocked silently** (no toast), unlike the documented rejection feedback.

## 2. Test-quality audit

### 2.1 Evidence for reported PASS rows

The device report is broadly grounded in screenshots, but it does not meet its own “every PASS has explicit evidence” bar:

- Rows with **no named screenshot/evidence** in the report: A12, D1, D7, D9, D14, R2, R7, R11. Some are negative observations (“long-press release did not preview”) that cannot be proven from the current evidence set.
- **A10 is labelled “PASS (partial)”** and explicitly says terminal/image/media arrays were not run, yet it is included in the 33 PASS count. A partial matrix must not count as a full PASS.
- **H-B9 is “PASS (list)”** while the in-preview half was blocked. It is also counted as one PASS.
- **H-C9** says 511/512 KB were not separately captured. My independent run confirms 512 KB exact renders and 513 KB truncates, but the report’s own evidence only shows 513 KB.
- `android-75-html-remembered.png` is a **terminal screenshot**, not the remembered HTML state its filename claims. It is not used as a PASS row (remember was marked BLOCKED), but it is misleading evidence.
- The 33 PASS count therefore should be read as “33 rows marked PASS, including at least two partial rows”; it is not 33 fully evidenced passes.

### 2.2 Unsupported or tautological automated claims

1. **The scheme-safety unit test is tautological for the Android failure.** `mobile/src/components/mobile-html-preview-frame.test.tsx` mocks `react-native-webview` and calls the component’s `onShouldStartLoadWithRequest` callback directly (`load('javascript:alert(1)', true)`). It proves that the pure policy returns `false`; it does not prove that Android’s WebView invokes that callback for a `javascript:` link. Android does not, which is exactly why the device behavior fails while the test is green. The automated report’s AC6 “scheme safety = Pass” is therefore unsupported as an end-to-end claim.
2. **There is no layout test for `MobileFileFilterChips`.** The file-browser tests cover category filtering and tree/result behavior, not the rendered dimensions of the chip row. The full-height column bug is invisible to the current suite.
3. **The save-notice tests mock `ActionSheetModal`** and assert props/state. They cannot detect whether a banner or sheet intercepts a row touch. The device FAIL “toast swallows touches” was therefore neither confirmed nor refuted by automated tests (and my run shows it is not the banner).
4. The automated AC coverage tables list **test file names as “Pass”**, not asserted behavior. They should distinguish “unit policy pass” from “device behavior pass”. The automated report is accurate about the suites it ran, but the AC tables read as stronger evidence than they are.

### 2.3 Automated failure classification

- **3 remaining mobile-suite failures — correctly classified.** The clean-HEAD log (`logs/clean-head-failing-files.log`) reproduces all three. `mock-server-key-pair` is a Node/tsx child-process import/toolchain failure (`loadOrCreateMockServerKeyPair is not a function`), not a product defect. The two `mobile-agent-launch-architecture` failures are deterministic assertion drift and are untouched by this branch. The report’s “pre-existing / environment / unrelated” label is acceptable, though those two are test drift rather than “environment”; they should be split into “toolchain” and “pre-existing test drift” in a final report.
- **16 diagnostics failures — correctly attributed and resolved.** The logs show features-only passes and diagnostics-only failures, and the named re-export fix restores 1,594/1,594 recording tests. Accept.
- **3 changed-code quality findings — correctly attributed to the diagnostics test and resolved.** The before/after logs match. Accept.
- **Ratchet invocation mismatch — correctly classified as an invocation issue**, not a code failure. Accept.

### 2.4 iOS blocker

**Confirmed as an environment blocker, not a product failure.** The installed Xcode is 16.4 (Swift 6.1.2). The checkout contains Expo 55 packages that require newer compiler/SDK behavior:

- `expo-modules-core` uses Swift 6.2 isolated conformances such as `extension UIView: @MainActor AnyArgument` (`ios/Core/Views/ViewDefinition.swift:121`), which Xcode 16.4 rejects as `unknown attribute 'MainActor'`.
- `expo-router` uses iOS 26 toolbar APIs (`UIBarButtonItem.Badge`, `.prominent`).
- `expo-notifications` uses `DateComponents.isRepeatedDay` (iOS 26).
- `expo-image-picker` uses `PHAsset.contentType` / `PHAssetResource.contentType` (iOS 26); the recorded build log shows both errors.

A build requires Xcode 26 / iOS 26 SDK. Marking all iOS-only acceptance cases BLOCKED is correct. The simulator screenshot `ios-00-home.png` supports “no app installed”.

## 3. Reproduction of the four reported FAILs

### 3.1 BLOCKER — Android HTML preview executes `javascript:`

**Steps (reproduced independently):**

1. Files → `page.html` → Preview.
2. Tap the `javascript link` (`javascript:alert(1)`).

**Expected:** No script execution; the scheme is rejected and the in-frame toast “This link type isn't supported in preview” appears (test-plan C10/C11b).

**Actual:** Native dialog “JavaScript / 1” with OK. The page’s inline script also ran, as intended. Existing evidence H-C3 (`android-70-external-link.png`) shows an `https` link opening Chrome without navigating the preview, so the failure is specific to `javascript:` (and likely other schemes Android intercepts internally).

**Root cause:** `mobile/src/components/MobileHtmlPreview.tsx:42-54` relies on `onShouldStartLoadWithRequest`. On Android, `javascript:` URLs are consumed by the WebView and are not delivered to the navigation callback, so the block branch never runs. The unit test calls the callback directly and cannot catch this. Fix needs a click/interception path that works on Android (for example injected JS posting blocked schemes to the host), not a change to the pure policy function.

**Evidence:** `device-evidence/screenshots/android-71-js-link-toast.png`; reviewer capture `/tmp/review-jsalert.png`. **Severity: BLOCKER.**

### 3.2 MAJOR — Filter chips render as full-height columns

**Steps:** Open Files (and repeat with the search keyboard open). Observe the All/Code/Docs/Media/Images/Other row.

**Expected:** One horizontal row of ~32 px chips; results immediately below.

**Actual:** Each chip is a tall column; the UI hierarchy gives the chip row bounds `[0,427][1080,1408]` (about 981 px, ~41% of the 2400 px screen), and visual height is ~850 px. Labels are vertically centered around y≈900. Search results are pushed below the fold; with the keyboard open they are not visible at all.

**Root cause:** `mobile/src/files/MobileFileFilterChips.tsx:14-19` uses a horizontal `ScrollView` with no height/flex constraint inside the Files flex column. The scroll view stretches to the remaining vertical space. Add a bounded height or `flexGrow: 0` and a layout test.

**Evidence:** `device-evidence/screenshots/android-11-files.png`, `android-66-filter-docs.png`; reviewer capture `/tmp/review-files1.png` and `/tmp/review-search1.png`. **Severity: MAJOR.**

### 3.3 NOT A PRODUCT DEFECT — Terminal highlight vs copied text

**Result: false positive.** The reported evidence shows a one-row selection, not a multi-row selection.

**Reproduction:** Long-press `src/main.ts:42` in the terminal. Pixel analysis shows selected-background pixels only on the `src/main.ts:42` row — y≈700–735 in `android-51-cjk-phrase.png`, and y 820–859 in the reviewer capture — while the start-handle dot sits above that row (reviewer capture: y 829–902 including stem) and the end-handle dot sits below it (y 859–942). The handles are anchored at the top of the first cell and the bottom of the last cell by design (`selection-overlay.ts:29-36`), so they overlap the adjacent rows visually. Copy produced exactly `src/main.ts:42`, matching the fill.

I also dragged a selection across six rows (from `修复` through the prompt); the highlight covered all selected rows and Copy showed the same multi-line text. CJK (`中文`), emoji (`😀`), 5-character CJK window (`人民共和国`), and handle crossing all matched. **TL-B11/B15 pass in this run.** The report’s “manual confirmation recommended” was the right instinct, but the observed state is not a mismatch. A minor UX note: boundary-anchored handles make one-line selections look larger than they are; this is the existing native-style design, not a bug.

**Evidence:** `android-51`, `android-53`, `android-55`; reviewer captures `/tmp/review-sel4.png`, `/tmp/review-sel5.png`, `/tmp/review-sel2.png`, `/tmp/review-sel3.png`, `/tmp/review-5char.png`, `/tmp/review-cross.png`. **Severity: none.**

### 3.4 NOT A PRODUCT DEFECT — “Saved to phone” toast swallows touches

**Result: false positive / misattribution.**

**Reproduction:** Save `page.html` to Documents, tap Done, leave the “Saved to phone” banner visible, then long-press a row. The file-action sheet opens on the first attempt. With the banner present, taps and long-presses on rows work.

Two different surfaces are involved:

- `MobileFileDownloadProgress` renders the notice as an ordinary in-flow banner (`mobile/src/files/MobileFileDownloadProgress.tsx:18-33`); it is not an overlay and does not intercept touches.
- `MobileFileSaveResultSheet` is an `ActionSheetModal`/`BottomDrawer` result sheet (`MobileFileSaveResultSheet.tsx`). While it is open it is a modal and does block the screen by design; the user must press Done or dismiss it. The report’s screenshots 19–22 only show the menu not opening; they do not show the banner intercepting a touch. The likely cause was the modal/dismiss timing or an `adb input` gesture that did not resolve as a long press.

The save itself is correct: `/sdcard/Documents/page.html` has SHA-256 `b2a8d6d145ac140336d0bceaf7b928b70ee9af58fe3c9a9b9ecd0680146e5e9a`, matching the fixture. **Severity: none for the reported defect.** Minor UX redundancy: the same save produces both a modal result sheet and a persistent banner.

**Evidence:** reviewer captures `/tmp/review-saved.png`, `/tmp/review-bannerlongpress.png`, `/tmp/review-aftersheet.png`.

## 4. Exploratory testing beyond the plans

| Area | Result |
|---|---|
| HTML overflow menu (B2) | **PASS / previously BLOCKED unnecessarily.** The floating dev gear overlaps the left part of the `...` button, but tapping its right edge (about x=1040, y=150) opens the app menu. Array exactly: Preview, Source, Save to phone, Open with, Copy content, Copy path, Cancel. |
| Truncated-file menu (B12) | **PASS.** 513 KB file: Source, Save to phone, Open with, Copy content (“Copies the first 512 KB”), Copy path, Cancel; no Preview. |
| HTML remember flow (H-A4/A5) | **PASS.** Toggled “Remember my choice” + Preview; reopening `page.html` went straight to Preview with no chooser. The reset-to-Ask path in Settings was not reached. |
| Source toggle (H-A3) | **PASS.** Source shows syntax-highlighted HTML matching the file, with the selected tab state. |
| 512 KB boundary (C9) | **PASS.** 512 KB exact renders; 513 KB forces Source, shows “File is larger than 512 KB...” and “Showing first 512 KB”, Preview disabled. 511 KB not separately captured. |
| Iframe (C18) | **PASS.** Sandboxed box renders; parent title unchanged; no external app. |
| Meta-refresh to `file:` (C12) | **MINOR defect.** No navigation to `file:///etc/passwd`, but also no “This link type isn't supported in preview” toast. Security outcome is safe; feedback is missing. |
| Terminal link sheet (TL-A1/A4/A6) | **PASS.** Phone / desktop-disabled-with-hint / Copy link / Cancel / Remember; URL summary and full-URL expansion work; copy overlay shows the full URL. |
| Link-adjacent long-press (C13) | **PASS.** Long-press on `前缀` selected `前缀` and did not open Chrome. The report’s inconclusive result did not reproduce. |
| Selection vectors | **PASS.** `中文` from `中文abc`; `😀` from the emoji’s right half; `English`; 5-character CJK window; multi-row copy; handle crossing. |
| Path tap | **PASS with keyboard hidden** (`config/scripts/orca-dev.mjs` opened a file tab). A bare/nonexistent path correctly did nothing. |
| Link tap while keyboard open (A25) | **Not a product defect in my run.** `adb shell input tap` did not open the sheet while the IME was focused; a 60 ms touch-down/up at the same point opened the sheet and dismissed the keyboard, as designed. Treat plain `input tap` as unreliable for this case; do not file it as a product bug without a real-finger or swipe-style gesture. |
| Save/open cancellation, SAF cancel/rename/revoke, large saves, terminal artifacts, LRU/orphan, SSH/folder-workspace, old host/binary, physical device, iOS | **NOT TESTED — not counted as pass.** |

## 5. Re-checks of reported BLOCKED items

| Reported BLOCKED item | Re-check |
|---|---|
| H-B2 preview overflow | **Reachable and PASS** by tapping the right edge of the ellipsis. Not a product blocker; dev overlay only partially overlaps. |
| H-B12 truncated menu | **PASS** (see above). |
| H-A3 Source toggle | **PASS.** |
| H-A4/A5 remember flow | **PASS** (Settings reset to Ask not tested). |
| H-C13 link-adjacent long-press | **PASS**; no Chrome launch. |
| TL-A8/A9 remember / reset | Not completed; the link sheet exposes Remember, but the Settings reset and subsequent direct-open behavior were not exercised. |
| iOS cases | Remain BLOCKED by the Xcode 26 environment. |
| Save-size matrix, cancellation, old-host/old-binary, SSH/folder, physical device | Remain NOT RUN. |

## 6. Findings and classifications

| ID | Severity | Finding | Product? | Evidence |
|---|---|---|---|---|
| R-01 | **BLOCKER** | Android HTML preview executes `javascript:` links instead of rejecting them | Yes | `android-71`; `/tmp/review-jsalert.png` |
| R-02 | **MAJOR** | Filter chips render as full-height columns, burying results | Yes | `android-11`, `android-66`; `/tmp/review-files1.png`; hierarchy bounds `[0,427][1080,1408]` |
| R-03 | **MINOR** | Meta-refresh to `file:` is blocked without the documented toast | Yes | reviewer capture of `meta-refresh.html` |
| R-04 | MINOR (UX) | Save shows both a modal result sheet and a persistent “Saved to phone” banner; redundant feedback | Yes (optional) | `android-18`; `/tmp/review-saved.png` |
| R-05 | **Not a bug** | Reported highlight/copy mismatch | No | one-row fill plus boundary handles; Copy matched; §3.3 |
| R-06 | **Not a bug** | Reported banner swallowing touches | No | long-press worked with banner visible; modal is expected; §3.4 |
| R-07 | Process | PASS count includes partial rows and rows with no named evidence | Report quality | §2.1 |
| R-08 | Process | B2/B12 and A3/A4/A5 were marked BLOCKED but are reachable | Report quality | §4/§5 |
| R-09 | Environment | iOS cannot build with Xcode 16.4 / Swift 6.1.2; needs Xcode 26 | No | §2.4; `ios-xcodebuild-1.log`…`-4.log` |
| R-10 | Test gap | Scheme-safety test mocks the WebView callback; no Android integration test | Test quality | `mobile-html-preview-frame.test.tsx`; §2.2 |
| R-11 | Test gap | No layout test for chips; no touch test through the save banner | Test quality | `MobileFileFilterChips.tsx`; mocked `ActionSheetModal` tests |

## 7. Required follow-up

1. Fix R-01 and add an Android-level test that taps a `javascript:` link in the real WebView; the pure-policy unit test is insufficient. Re-run C10/C11b/C12 on Android.
2. Fix R-02 and add a layout/E2E assertion for chip-row height (including the keyboard-open state).
3. Add the missing blocked-scheme toast for meta-refresh (R-03), or explicitly document the silent-block behavior as acceptable and update the test plan.
4. Correct the device report’s PASS accounting: split partial rows, attach evidence for A12/D1/D7/D9/D14/R2/R7/R11, and remove or relabel the misleading `android-75` capture.
5. Re-run the reachable “BLOCKED” cases (B2/B12, A3/A4/A5) and record the actual menu arrays and remember state.
6. Do not count iOS as pass; build with Xcode 26 and repeat the iOS device matrix.
7. Test the remaining untested save/cancel/large-size/old-host/SSH cases before release.

## 8. Evidence notes

- Existing screenshots are under `remote-connectivity/design/test-reports/device-evidence/screenshots/`; existing logs under `.../device-evidence/logs/` and `.../test-reports/logs/`.
- Reviewer captures referenced as `/tmp/review-*.png` were captured during this review from the same emulator/APK and are not committed. Key ones: `review-jsalert.png`, `review-files1.png`, `review-search1.png`, `review-sel4.png`, `review-sel5.png`, `review-saved.png`, `review-bannerlongpress.png`, `review-513.png`, `review-512.png`, `review-overflow1.png`, `review-source2.png`, `review-remember-open2.png`, `review-iframe.png`, `review-pathtap.png`.
- Independently verified save hash: device `/sdcard/Documents/page.html` = `b2a8d6d145ac140336d0bceaf7b928b70ee9af58fe3c9a9b9ecd0680146e5e9a`, matching the fixture.
