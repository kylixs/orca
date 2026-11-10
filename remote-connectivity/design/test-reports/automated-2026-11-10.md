# Automated Test Report — Mobile File Browser, Terminal Link/Selection, HTML Open Modes

- Date: 2026-11-10
- Repo: `/Users/gongdewei/work/projects/orca`
- Branch: `feat/remote-terminal-load-diagnostics`
- Tested commit: `324078d8471` (all three feature changes are uncommitted on top)
- Scope: automated execution only. No product code or test files were modified. No commits made.
- Evidence logs: `remote-connectivity/design/test-reports/logs/`
- Latest state: rerun after the diagnostics recording fix; section 2a is authoritative. Section 2 and section 3.1/3.3 are kept as the pre-fix baseline.

## 1. Environment

| Item | Value |
|---|---|
| OS | macOS 15.6 (Darwin 24.6.0), arm64 (Apple T8132) |
| Node | v24.5.0 |
| pnpm | 12.8.1 |
| TypeScript | 7.0.2 |
| oxlint | 1.86.0 |
| Mobile Vitest | 4.1.11 (997 files discovered) |
| Root Vitest | 5.0.3 |
| tsx | 4.23.15 |
| Android tools | `adb` present at `~/Library/Android/sdk/platform-tools/adb`; `adb devices` → no devices attached, no emulator running |
| iOS tools | Xcode 16.4 (16F6); `xcrun simctl` lists iOS 18.6 devices (iPhone 16 Pro/Max/16e/16/16 Plus, iPads), all Shutdown |
| Working tree | 155 changed files seen by the quality gate (77 tracked modified + new feature files) |

Device E2E (SAF/ACTION_VIEW, iOS Save to Files, real long-press/drag, WebView rendering) was **not executed**; no device was attached and this task was scoped to automated suites.

## 2. Command matrix — initial run (pre-fix baseline)

| # | Command | Exit | Result | Duration | Log |
|---|---|---|---|---|---|
| 1 | `pnpm --dir mobile test` | **1** | 997 files: 990 passed, 5 failed, 2 skipped. 10,658 tests: 10,633 passed, 19 failed, 6 skipped | 53.75 s | `logs/mobile-test.log` |
| 2 | `pnpm --dir mobile typecheck` | 0 | `tsc --noEmit`, clean | 9 s | `logs/mobile-typecheck.log` |
| 3 | `pnpm --dir mobile lint` | 0 | `oxlint`, clean | 1 s | `logs/mobile-lint.log` |
| 4 | `pnpm tc` | 0 | All four projects (node/web/cli/process-host) clean. Warm `*.tsbuildinfo`; direct runner re-run 2.17 s | 3 s | `logs/root-tc.log` |
| 5a | `node mobile/scripts/check-tests-typecheck-ratchet.mjs` (from repo root, as specified) | **1** | `Missing mobile/tests-typecheck-baseline.txt` — script resolves the baseline relative to cwd | <1 s | `logs/mobile-tests-typecheck-ratchet.log` |
| 5b | same script from `mobile/` (`cd mobile && node scripts/...`) | 0 | 993 test files in program, 4 intentionally excluded, 0 `@ts-nocheck`, 122 grandfathered, all others check | 14 s | `logs/mobile-tests-typecheck-ratchet-mobile-cwd.log` |
| 6 | `pnpm run check:code-quality:changed` | **1** | 155 changed files. 3 new findings, all in the pre-existing diagnostics test change | 5 s | `logs/code-quality-changed.log` |
| 7/8 | `pnpm test <10 focused host/renderer files>` | 0 | 10 files, **118 tests passed** | 3 s | `logs/focused-host-tests.log` |
| 7 | Mobile protocol/status gates | 0 | 1 file, **8 tests passed** | <1 s | `logs/feature-protocol-status-tests.log` |
| 9 | `pnpm --dir mobile test native-document-bundle.test.ts` (terminal + rich Markdown) | 0 | 2 files, **16 tests passed**; generated bundle matches sources | 1 s | `logs/mobile-native-document-bundle.log` |

### Focused host/renderer files (commands 7/8)

- `src/main/runtime/orca-runtime-files-search.test.ts`
- `src/main/runtime/orca-runtime-files-mobile-explorer-reads.test.ts`
- `src/main/runtime/orca-runtime-files-preview-budget.test.ts`
- `src/main/runtime/runtime-file-commands-mobile-file-truncation.test.ts`
- `src/main/runtime/runtime-file-listing-producer-budgets.test.ts`
- `src/main/runtime/runtime-extraction-regressions.test.ts`
- `src/main/runtime/orca-runtime-files-ssh-chunk-reads.test.ts`
- `src/main/runtime/orca-runtime-files-terminal-artifact-io.test.ts`
- `src/renderer/src/runtime/runtime-file-client-search-listing.test.ts`
- `src/renderer/src/runtime/runtime-file-search-bounds.test.ts`
- `mobile/src/transport/host-status-gates.test.ts`

### Feature-focused mobile batches (all pass)

| Feature | Command scope | Files | Tests | Exit |
|---|---|---|---|---|
| File browser | `src/files/*` core, files route, file actions/open/share, preferences | 31 | **304 passed** | 0 |
| Terminal link/selection | `TerminalLinkActionSheet`, `terminal-link-*`, `selection-range`, `text-tokenizer`, tap routing, document/selection suites | 17 | **199 passed** | 0 |
| HTML open modes | `mobile-html-open-mode`, HTML preview scheme/frame/links, relative assets, open-mode sheet, preview body/actions | 16 | **116 passed** | 0 |

Logs: `logs/feature-file-browser-tests.log`, `logs/feature-terminal-link-selection-tests.log`, `logs/feature-html-open-modes-tests.log`.

## 2a. Rerun after diagnostics fix (authoritative)

The diagnostics recording blocker was fixed with explicit named re-exports in `mobile/src/session/mobile-terminal-diagnostics.ts` (the RPC-recording loader can enumerate named re-exports but not `export *`). All commands below were rerun against the fixed working tree.

| # | Command | Exit | Result | Duration | Log |
|---|---|---|---|---|---|
| 1 | `pnpm --dir mobile test` | **1** | 997 files: 993 passed, 2 failed, 2 skipped. 10,658 tests: **10,649 passed, 3 failed**, 6 skipped | 62.18 s | `logs/rerun-mobile-test.log` |
| 2 | `pnpm --dir mobile typecheck` | 0 | `tsc --noEmit`, clean | 29 s | `logs/rerun-mobile-typecheck.log` |
| 3 | `pnpm --dir mobile lint` | 0 | `oxlint`, clean | 3 s | `logs/rerun-mobile-lint.log` |
| 4 | `pnpm tc` | 0 | All four projects clean (warm incremental cache) | 4 s | `logs/rerun-root-tc.log` |
| 5 | `cd mobile && node scripts/check-tests-typecheck-ratchet.mjs` | 0 | 993 files in program, 4 excluded, none `@ts-nocheck`, 122 grandfathered | 23 s | `logs/rerun-tests-typecheck-ratchet.log` |
| 6 | `pnpm run check:code-quality:changed` | **0** | 155 changed files, **0 new findings** in every category | 7 s | `logs/rerun-code-quality-changed.log` |

Remaining failures in the full mobile suite are exactly the 3 pre-existing/environment tests:

| File | Tests |
|---|---|
| `mobile/src/mock-server-key-pair.test.ts` | 1: `makes concurrent creators converge on the persisted winner` |
| `mobile/src/tasks/mobile-agent-launch-architecture.test.ts` | 2: `shares one durable receipt across entry points and a reopened store`, `replays an exhausted collision after restart without searching names again` |

These reproduce identically on clean HEAD (`324078d8471`), so they are not caused by the three features or by the diagnostics changes. All 16 RPC-recording failures and the 3 quality-gate findings from the initial run are gone; a direct rerun of the three recording suites exits 0 with **1,594/1,594 tests passed** (`logs/rerun-rpc-recordings.log`). The feature batches were not rerun separately because the full suite already contains them and produced no unexpected result.

## 3. Failures and classification (initial run, pre-fix baseline)

> Status after the rerun: sections 3.1 and 3.3 are **resolved**; only section 3.2 remains.

### 3.1 Attributable to pre-existing uncommitted diagnostics changes (16 tests) — RESOLVED

All of these are deterministic, and all pass when the diagnostics refactor is reverted in a temporary clean-HEAD worktree.

| File | Failing tests |
|---|---|
| `mobile/src/test-support/rpc-recording/family-recordings.test.ts` | 4: `matrix-session.tab-reveal-session.tabs.list-1`, `...tabs.activate-1`, `matrix-session.tab-activation-terminal.focus-1`, `matrix-session.tab-activation-session.tabs.activate-1` |
| `mobile/src/test-support/rpc-recording/pilot-recordings.test.ts` | 4: `sc-reveal-first-poll`, `session-tab-activation-focus-and-activate`, `session-tab-activation-refused`, `session-tab-activation-transport-error` |
| `mobile/src/test-support/rpc-recording/rpc-recording-through-bridge.test.ts` | 8: the same scenarios plus `replays every golden byte for byte...` |

**Root cause (verified):** the diagnostics refactor split the log primitives into `mobile/src/session/mobile-terminal-diagnostic-log.ts` and re-exported them from `mobile/src/session/mobile-terminal-diagnostics.ts` with `export *`. The RPC-recording harness evaluates product modules in a VM (`operation-module-loader.ts`). After the refactor that loader exposes only `MobileTerminalDiagnostics` from the diagnostics module; `shortenMobileTerminalDiagnosticId` and `logMobileTerminalDiagnostic` are `undefined` there. `mobile/src/session/mobile-session-tab-activation.ts` imports those helpers, so activation throws before issuing `session.tabs.activate` / `terminal.focus`; the recordings then see a missing or already-completed request.

**Exact implicated files:**
- `mobile/src/session/mobile-terminal-diagnostics.ts`
- `mobile/src/session/mobile-terminal-diagnostic-log.ts` (new, untracked)
- `mobile/src/session/mobile-terminal-load-timing.ts` (new, untracked)

The terminal-subscription change (`mobile/src/session/use-mobile-session-terminal-subscription.ts`) is **not** the trigger: the diagnostics class + helpers alone reproduce all 16 failures. The remote scroll change (`src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-wheel.ts`) is not loaded by the mobile replay harness.

**Evidence:**
- All changes applied in temp worktree: 3 files failed / 16 tests failed (`logs/temp-all-changes-rpc.log`).
- Diagnostics class + two new helper files only: 16 failed (`logs/temp-diag-class-only-rpc.log`, `--no-cache`: `logs/temp-diag-class-only-nocache-rpc.log`).
- Diagnostics reverted, features kept: 3 files / 1,594 tests pass (`logs/temp-features-only-rpc.log`, `--no-cache`: `logs/temp-features-only-nocache-rpc.log`).
- Clean HEAD, all three rpc files: pass (`logs/clean-head-failing-files.log`).

### 3.2 Pre-existing / environment / unrelated (3 tests)

These reproduce **identically on a clean HEAD worktree** (`324078d8471`) with the same dependencies, so they are not caused by any of the three features or the diagnostics changes.

| File | Failing tests | Detail |
|---|---|---|
| `mobile/src/mock-server-key-pair.test.ts` | 1: `makes concurrent creators converge on the persisted winner` | Child `tsx --eval` import returns no export: `TypeError: loadOrCreateMockServerKeyPair is not a function`; Node 24.5.0 + tsx 4.23.15 toolchain |
| `mobile/src/tasks/mobile-agent-launch-architecture.test.ts` | 2: `shares one durable receipt across entry points and a reopened store`, `replays an exhausted collision after restart without searching names again` | Deterministic assertion drift (`createManagedWorktree` called twice; reused receipt returns `ok: true` instead of `worktree_create_collision`) |

Evidence: `logs/clean-head-failing-files.log`.

### 3.3 Changed-code quality gate (3 findings) — RESOLVED

Initially, `pnpm run check:code-quality:changed` failed on type assertions in `mobile/src/session/mobile-terminal-diagnostics.test.ts` lines 67, 80, 92 (`typescript/consistent-type-assertions`). After the fix, the gate passes with 0 new findings in every category.

### 3.4 Ratchet invocation mismatch (not a code failure)

The literal command in the task (`node mobile/scripts/check-tests-typecheck-ratchet.mjs` from the repo root) fails because the script resolves `tests-typecheck-baseline.txt` and `tsconfig.test.json` from the cwd. Run from `mobile/` (or via `pnpm --dir mobile check:tests-typecheck`) it passes: 993 files in the program, 122 grandfathered, none opted out. Baseline exists at `mobile/tests-typecheck-baseline.txt`.

## 4. Feature AC coverage summary (automated)

All automated coverage for the three features is green. No failure in the run is attributable to any of the three features.

### File browser (`remote-connectivity/design/2026-11-10-mobile-file-browser/test-plan.md`)

| AC | Automated coverage | Status |
|---|---|---|
| AC1 long-press select/copy | `MobileFileExplorerPanel.test.ts`, `mobile-file-copy-content`, `mobile-file-preview-*`, selection tests | Pass |
| AC2 action menu (list/preview/type matrix) | `MobileFileOpenModeSheet*`, `file-action-capabilities`, `MobileFilePreviewScreen.actions`, `use-mobile-file-actions` | Pass |
| AC3 save/open results and errors | `mobile-file-prepare`, `mobile-file-save`, `mobile-file-download-cache`, `open-file`, `share-file`, `file-read-failures` | Pass |
| AC4 progress/cancel | `mobile-file-download-cache`, save/prepare action tests | Pass |
| AC5 search/filter | `use-mobile-file-search`, `file-tree-filter`, `MobileFileSearchResults`, `mobile-file-preview-navigation` | Pass |
| AC6 regressions | Full mobile suite except the non-feature failures above; host listing/search/truncation 118 tests | Pass |

Device-only cases (SAF, ACTION_VIEW/FileProvider, iOS Save to Files, real long-press) were not run — no device attached.

### Terminal link/selection (`.../mobile-terminal-link-selection/test-plan.md`)

| AC | Automated coverage | Status |
|---|---|---|
| AC1 HTTP/HTTPS link sheet | `TerminalLinkActionSheet.test.tsx`, `terminal-link-presentation`, `terminal-link-open-policy`, `use-mobile-session-content-create-actions` | Pass |
| AC2 CJK/emoji/wide-char selection geometry | `selection-range.test.ts`, `text-tokenizer.test.ts` (G1–G30 vectors), `native-document-bundle.test.ts` | Pass |
| AC3 nearby word/phrase snapping | `selection-range`, `text-tokenizer` | Pass |
| AC4 highlight/copy/handle consistency | `selection-range`, `native-document-bundle`, terminal document suites | Pass |
| AC5 input/scroll/OSC/path/copy regressions | `terminal-webview-tap-routing`, terminal document suite, full mobile suite | Pass |

Device-only long-press/drag/sheet behavior was not run — no device attached.

### HTML open modes (`.../mobile-html-open-modes/test-plan.md`)

| AC | Automated coverage | Status |
|---|---|---|
| AC1 first-click mode sheet | `MobileFileOpenModeSheet*`, `mobile-html-open-mode` | Pass |
| AC2 preview/source switching | `use-mobile-file-preview-html-mode`, `MobileFilePreviewScreen.actions`, `mobile-file-preview-source`, `-line-column`, `-syntax` | Pass |
| AC3 overflow/long-press menus | `MobileFileExplorerPanel.test.ts`, `MobileFileOpenModeSheet*` | Pass |
| AC4 remember/restore preference | `mobile-html-open-mode`, `use-mobile-file-preview-html-mode`, `browser-settings-screen.test.tsx`, `preferences.test.ts` | Pass |
| AC5 relative assets / 512 KB truncation | `html-relative-assets`, `mobile-file-preview-*`, host preview-budget tests | Pass |
| AC6 external links / scheme safety | `html-preview-scheme`, `mobile-html-preview-frame`, `html-preview-inert-links`, `html-preview-link-affordance`, `use-html-preview-link-grant.web` | Pass |
| AC7 regressions | Full mobile suite; Markdown/HTML preview tests | Pass |

Device-only WebView rendering, navigation and dangerous-scheme behavior were not run — no device attached.

### Generated terminal document bundle (task item 9)

The 16-test bundle suite passes. `mobile/src/terminal/document/native-document-bundle.test.ts` rebuilds the bundle in a temp directory and asserts both:
- SHA-256 of the rebuilt bundle equals the checked-in `TERMINAL_DOCUMENT_SCRIPT` (`bundleDigestBuiltFrom(tmpdir(), generator, 'terminalDocumentBundle')`), and
- the rebuilt script equals `TERMINAL_DOCUMENT_SCRIPT`.

The rich-Markdown bundle test does the same for its generated document. Confirmed: generated bundle matches sources.

## 5. Blocking issues

1. **No feature or diagnostics blockers remain.** The explicit named re-exports fixed all 16 diagnostics-attributable RPC-recording failures (1,594/1,594 recording tests pass in the rerun), and the changed-code quality gate is clean.
2. **Remaining pre-existing failures (not feature- or diagnostics-attributable):** `mock-server-key-pair` (1) and `mobile-agent-launch-architecture` (2) fail on clean HEAD too. They keep `pnpm --dir mobile test` at exit 1 locally but are unchanged by this branch.
3. **Evidence gap (not a failure):** iOS/Android device acceptance from all three test plans has not been executed in this automated pass.

### CI status

- All feature, diagnostics, typecheck, lint, ratchet and changed-code-quality gates are green locally.
- The full mobile suite is red only on the 3 pre-existing failures above. Because they reproduce on clean HEAD, this branch introduces no new red. If the CI mobile job reproduces them on its Node 24 toolchain, the job stays red independently of this branch; if they are macOS-only, the Linux CI job may be green.
- The changes are still uncommitted, so no remote CI run exists for them yet.

**Explicit verdict: every automated test attributable to the three features (file browser, terminal link/selection, HTML open modes) and to the diagnostics fix passes.** In the authoritative rerun, the full mobile suite reports 10,649 passed and only the 3 clean-HEAD failures; typecheck, lint, root typecheck, the tests-typecheck ratchet, and the changed-code quality gate all exit 0. The generated terminal document bundle still matches its sources.

## 6. Final rerun after fix-01..fix-05 (2026-11-10)

`regression-01.md` re-ran the full suite on the final worktree after the security, layout, meta-refresh, subframe and adopted-frame fixes:

| Command | Result |
|---|---|
| `pnpm --dir mobile test` | 999 files (995 pass, 2 fail, 2 skip); 10,696 tests: **10,687 pass, 3 fail, 6 skip** |
| `pnpm --dir mobile typecheck` | exit 0 |
| `pnpm tc` | exit 0 (all four projects) |
| `pnpm run check:code-quality:changed` | **0 new findings across 172 changed files**; gate passed |
| Focused fix tests | 5 files / 75 tests passed |

The failure set is unchanged and exactly the three clean-HEAD failures (`mock-server-key-pair`, two `mobile-agent-launch-architecture`). No diagnostics/RPC-recording test fails. The added fix tests bring the suite from 10,658 to 10,696 tests. Evidence: `device-evidence/regression-01/logs/mobile-test-full.log`, `mobile-typecheck.log`, `root-tc.log`, `code-quality-changed-final.log`, `focused-fix-tests.log`.
