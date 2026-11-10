# 代码评审 02 — 移动端文件浏览（code-review-01 修复后复评）

范围：`reviews/code-review-01.md` 的 B1/B2、M1-M5、m1-m10，`design.md`、`test-plan.md`、`tasks.md`，以及当前工作区中的文件浏览实现与测试。终端选择、terminal-link、HTML Frame 的并行改动只在文件浏览重叠处核对。

结论：**CHANGES_REQUESTED**

Findings 统计：**BLOCKER 1 / MAJOR 0 / MINOR 5**。

已执行（只读）：

- `pnpm --dir mobile typecheck`（`tsc --noEmit`）— **通过**（复评期间并行 HTML 重构曾短暂报 `hasLineTarget`/`htmlOpenMode` 类型错，重构落定后为 0 错）。
- `node mobile/scripts/check-tests-typecheck-ratchet.mjs`（在 `mobile/` 下运行）— **通过**：992 个测试文件在 program 中，122 个 grandfathered，无新增失败。
- `pnpm run check:code-quality:changed` — 本需求文件 **0 new findings**；全仓仍有 3 条，全部在并行改动的 `mobile/src/session/mobile-terminal-diagnostics.test.ts:67/80/92`（非本功能）。
- `npx oxlint --config config/oxlint-code-quality-native-plugins.json --deny-warnings <feature files>` — 通过（exit 0）。
- `pnpm tc:node` — 通过。
- `npx vitest run src/files src/platform/share-file.test.ts src/platform/open-file.test.ts src/settings/browser-settings-screen.test.tsx src/components/mobile-markdown-android-selection.test.tsx src/mobile-web-shell` — **144 文件 / 1772 用例通过**。
- `npx vitest run`（mobile 全量）— 6 文件 / 29 用例失败。其中 4 个文件是本需求的 `files.explorer-screen` golden / bridged parity（见 B1），其余为并行改动或既有无关失败（`session.tab-*`、`sc-reveal-first-poll`、`mock-server-key-pair`、`mobile-agent-launch-architecture`）。
- `npx vitest run src/main/runtime/rpc/methods/files-path-search.test.ts src/main/runtime/runtime-extraction-regressions.test.ts src/main/runtime/runtime-file-listing-producer-budgets.test.ts src/main/runtime/rpc/methods/files.test.ts` — 58 用例通过。

---

## BLOCKER

### B1. 文件浏览面板在 RPC recording harness 中崩溃，4 组 explorer golden 无法回放，mobile CI 必红

`mobile/src/files/MobileFileOpenModeSheet.tsx:2,82` 在渲染期读取 `react-native` 的 `Switch`；`MobileFileExplorerPanel.tsx:370-375` 无条件挂载该 sheet（`visible={pendingHtmlOpen !== null}`，关闭时仍会构造其 JSX）。recording harness 的 `reactNativeScreenMembers()`（`mobile/src/test-support/rpc-recording/screen-native-substitutes.ts:85-99`）没有 `Switch`，loader 的 partial module 直接抛：

```
Unsubstituted native member: react-native.Switch
```

`screenMount` 把它记成 crash，面板因此从不发出 `files.readDir`，所有 explorer 录制在第一次 `complete("files.readDir#1")` 就失败：

- `src/test-support/rpc-recording/mounted-screen-tree.test.ts` — `Missing or completed request: files.readDir#1`
- `src/test-support/rpc-recording/pilot-recordings.test.ts` — `files-explorer-legacy-fallback`、`files-explorer-readdir`
- `src/test-support/rpc-recording/family-recordings.test.ts` — `matrix-files.explorer-screen-files.list-1`、`...readdir-1`
- `src/test-support/rpc-recording/rpc-recording-through-bridge.test.ts` — 同一批 golden 变成 `unclassified`，并使 C3 closure pin 漂移

失败场景：`pnpm --dir mobile test`（CI 的 mobile suite）在任一 PR/push 上都会红；这不是并发 terminal/session 失败，也不是“golden 需要更新”——golden 本身要求面板成功挂载并发送请求。

修复：在 `reactNativeScreenMembers()` 的 inert elements 中加入 `'Switch'`（关闭抽屉时不渲染它，因此不会改变现有 golden 的 elements 计数）；或让 `MobileFileOpenModeSheet` 在未打开时不要构造 `Switch` 元素。修完后重新跑上述四个 recording 测试确认 golden 能回放。

> 归属说明：`MobileFileOpenModeSheet` 位于 `mobile/src/files/`，是本功能的面板依赖；该崩溃在 review-01 时不存在（当时全量 suite 的 explorer golden 通过），是之后（很可能是并行 HTML 打开方式改动）引入的新回归。即使由并行批次修复，当前分支状态也不能合入。

---

## MAJOR

无。review-01 的 M1-M5 已按要求修复：

- **M1** `use-mobile-file-search.ts:120-163` 在 effect 顶部统一 `sequenceRef += 1` 并清 timer，缓存/离线/空查询分支都会作废在途请求；补了缓存命中与断线两条竞态测试。
- **M2** `rankFileSearchPaths` 返回 `{ paths, totalCount }`（`:46-80`），旧主机结果头按真实匹配数显示“Showing first 32 of N matches”；补了 40 匹配 >32 用例。
- **M3** 新增可选 wire 字段 `libraryTruncated`（`src/shared/runtime-file-contracts.ts:14-16`、`src/main/runtime/runtime-file-commands-constructor.ts:80,131`），移动 schema 保留它（`file-explorer-reply-schema.ts:50`），reader 区分“库截断”和“匹配截断”（`use-mobile-file-search.ts:232-233`），note 分开输出 20k/5000 提示（`MobileFileSearchResults.tsx:87-111`）；兼容旧 host 只有 `truncated` 的推断；补了 20k 用例。
- **M4** Save/Open 成功后 `task.forget()` 丢弃 ready（`use-mobile-file-actions.ts:86-87,120-122`），下次重新 stat/read；下载缓存清理/LRU 通过 `subscribeDownloadCacheInvalidation` 同步丢弃 ready（`mobile-file-action-tasks.ts:191-209`）；补了“再次保存会重新 prepare”用例。
- **M5** 新增 `mobile-file-prepare.test.ts`、`mobile-file-save.test.ts`、`mobile-file-copy-content.test.ts`、`platform/share-file.test.ts`、`platform/open-file.test.ts`，覆盖分块/字节数/前后 stat/取消清理、15.9/16/16.1 MB、终端预算、grant 刷新转发、SAF 重名与取消等。

---

## MINOR

### m1. 预览页对“无扩展名/未知扩展名文本”误判为 binary，丢失 Copy content

`mobile/src/files/mobile-file-target-kind.ts:46-50`

M7 修复把预览 target 改成按 MIME 分类：`mimeTypeForFileName()` 对 `.log`、`.conf`、`Makefile`、`LICENSE`、`.env` 等返回 `application/octet-stream`，于是 `fileTargetKindForPreviewPath` 返回 `'binary'`。列表侧仍用 `getMobileFileKind`（默认 text），所以同一文件：

- 列表长按：有 Copy content（服务端返回 `kind: 'text'`）；
- 进入预览页：sheet 只给 Save/Open/Copy path，没有 Copy content。

失败场景：打开 `LICENSE`/`Makefile` 的预览，用户无法从预览菜单复制内容，与 7.2 “文本/代码 → Copy content”不一致；且 `previewable` 也被置 false。PDF/zip 修复本身正确，但默认分支应从“未知即 binary”改为“未知即 text，仅已知二进制扩展名归 binary”（例如复用 `getMobileFileKind`/远端 binary 表），并补 `LICENSE`/`foo.log` 用例。

### m2. 能力部分缺失时没有 “Update Orca…” 提示

`mobile/src/files/mobile-file-actions.ts:204-208`、`mobile/src/files/file-action-capabilities.ts:29-34`

`fileActionCapabilityNotice` 仅在 `saveToPhone` 和 `openWith` **都**为 false 时返回提示。Android 二进制若只有 SAF、没有 `ExpoIntentLauncher`/`contentUri`，则会静默隐藏 Open with（Save 仍在），用户看不到 8.5/C6 要求的 “Update Orca on this device to use file actions”。失败场景：旧 Android 包在 sheet 中只有 Save、无 Open、无解释。建议：任一动作因模块缺失被隐藏时都显示提示（或给出对应动作的 “Update Orca” hint）。

### m3. 修复后残留死代码

- `mobile/src/files/mobile-file-action-tasks.ts:45,217`：`version` 只自增、无人读取（`getFileActionTasksVersion` 已删除，计数遗留）。
- `mobile/src/files/use-mobile-file-search.ts:30,41,235,267`：`libraryTotalCount` 只写不读，note/UI 都未使用。
- `mobile/src/files/MobileFileSaveResultSheet.tsx:15-21`：`kind === 'shared'` 分支不可达——`use-mobile-file-actions.ts:88-95` 在 shared 分支把 `saveResult` 设为 `null`。要么删掉该分支，要么补上“Shared file”结果页并明确它不代表落盘成功。

这些不影响行为，但 m9 的目标是清理误导性死代码，建议顺手收口。

### m4. 搜索提示文案硬编码上限，且 note 输入里留有未使用字段

`mobile/src/files/MobileFileSearchResults.tsx:72-75,90-110`

提示串里 “first 32”“first 5000”“20,000” 是字面量，而实际上限来自 `FILE_SEARCH_RESULT_LIMIT`、`LEGACY_FILE_LIST_LIMIT`、服务端 `MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT`；任一处调整后 UI 会说谎。`MobileFileSearchNoteInput` 仍声明 `truncated` 但函数从不读取。建议从常量派生前两者，并删除未使用的 Pick 字段（20k 文案可保留在共享常量旁）。

### m5. M4 的“缓存清理/LRU 使 ready 失效”没有直接测试

`mobile/src/files/mobile-file-action-tasks.ts:191-209` 的订阅已实现，但 `mobile-file-download-cache.test.ts:67-77` 只断言监听器被调用（`null` / `new Set()`），`mobile-file-action-tasks.test.ts` 只覆盖 `forget`。把“clearDownloadCache 后 ready 变 idle”“按目录名淘汰后对应任务 idle、其他任务保留”补成 action-task 测试，才能防止 M4 回退时无人发现。

---

## 已核对且未发现问题的修复点

- **B1** ratchet 通过（992 files；review-01 点名的两个新测试已改为类型安全写法）。
- **B2** changed-quality 对本功能文件 0 finding（重复 import、类型断言、无效 disable、effect 规则、`as unknown as` 均已处理）；全仓剩余 3 条在并行 `mobile-terminal-diagnostics.test.ts`。
- **m1** Copy path 不再清除读失败（`use-mobile-file-actions.ts:161-173`），剪贴板失败不再标 read_failed（`:151-157`），“Waiting for desktop...” 归 network（`file-read-failures.ts:47-58`），重连只清网络类失败，均有测试。
- **m2** shared 分支不再报 “Saved to phone”，也不展示确定性成功结果页（`use-mobile-file-actions.ts:88-95`），有 “never reports a dismissed share sheet as Saved” 测试。
- **m3** 元数据移到 `.orca-meta` 独立目录（`mobile-file-download-cache.ts:14-16,290-303`），载荷目录不会被 `.orca-download.json` 覆盖。
- **m4** `busy` 暴露到两个 sheet，Save/Open 在 preparing 时 disabled，hook 侧 `busyRef` 双保险，有重复 Save 测试。
- **m5** `retry` 改为按共享 task state 的 `action` 重放，有“新挂载实例仍能重试”的测试。
- **m6** chips 增加上下 `hitSlop: 6`（32+12=44），预览 header Save 加 `hitSlop={8}`（36+16=52）。
- **m7** PDF/zip 深链预览按路径归 binary，补了 `mobile-file-preview-action-target.test.ts`（副作用见 m1）。
- **m8** LRU 测试名改为 “evicts the only entry when it alone exceeds the cap”。
- **m9** 原先点名的 `FileActionTargetKindWithoutDirectory`/`fileActionLabel`/`getFileActionTasksVersion`/`capabilityNotice` 死绑定、`rowDisabled`/`rowTitleDisabled`、`mobileFilePreviewShellParams`、600 ms 点击 guard、类型谓词 `terminalArtifactTooLarge` 均已清理（残留见 m3）。
- **m10** `app.json` 已升到 0.0.52 / buildNumber 2 / versionCode 19；`EXPO_PUBLIC_FILE_ACTIONS=off` 可隐藏 Save/Open 且无需新原生包（`file-action-capabilities.ts:43-52`，有测试）；grant 刷新后的 source 通过 `startFileActionTask` → preview `setPreviewSource` 回传并补了转发测试。
- **动作数组**：文本/Markdown/HTML、图片/媒体、PDF/二进制、目录、终端文本/图片/超预算、readFailed、preview context 省略 Preview、能力缺失降级均与 7.2/A10 一致；HTML 的 Preview/Source 模式对在两个 context 下都只出现一次（`MobileFilePreviewScreen.actions.test.tsx` 全绿）。
- **HTML builder 兼容**：`MobileFileActionSheet`/`MobileFilePreviewOverlays`/`use-mobile-file-preview-actions` 已收敛到单一 `htmlActionState`，`buildFileActions` 不再接受 `htmlOpenMode`；当前 `tsc` 与组件测试均绿。
- **终端产物语义**：>512 KB 文本/ >3 MB 图片只剩 Copy path；Copy path 用 `pathText ?? displayPath`；预览 target 在 too-large 时注入超限 size；可编辑文本 header Save 仍只对 dirty 可编辑文本渲染。

## 合并建议

1. 先修 **B1**（`Switch` substitute 或关闭时不构造 Switch），再重跑全部 `rpc-recording` 测试与 `pnpm --dir mobile test`；这是当前唯一确定会让本功能 CI 变红的项。
2. m1（预览页 Copy content 误丢失）建议同 PR 修掉，它直接违反 7.2 的文本行。
3. m2/m3/m4/m5 可同 PR 或紧接的清理 PR 处理。

> 并发改动提示：本次全量 suite 的 `session.tab-*`、`sc-reveal-first-poll`、`mock-server-key-pair`、`mobile-agent-launch-architecture` 失败与文件浏览无关；changed-quality 的 3 条失败也全部在并行的 terminal diagnostics 测试里。合入前需由对应改动方清零，否则分支整体仍红。
