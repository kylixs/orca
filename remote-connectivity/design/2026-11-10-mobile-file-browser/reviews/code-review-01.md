# 代码评审 01 — 移动端文件浏览

范围：`design.md`（第 8 节优先）、`test-plan.md`、`tasks.md`、`reviews/design-review-05.md`，以及工作区中的文件浏览实现（`mobile/src/files/*`、`mobile/src/platform/{share-file,open-file}.ts`、设置页行、文件路由、`MobileMarkdown`/预览改动）。终端选择与 terminal-link 的并行改动不在本次评审范围内。

结论：**CHANGES_REQUESTED**

Findings 统计：**BLOCKER 2 / MAJOR 5 / MINOR 10**。

已执行（只读）：

- `pnpm --dir mobile typecheck` — 功能文件无错误；现存错误全部在并行改动的 `use-mobile-session-screen-state.ts` / `terminal/document/cell-geometry.ts`。
- `npx vitest run src/files src/components/mobile-markdown-android-selection.test.tsx src/mobile-web-shell/...` — 39 文件 / 348 用例通过。
- `npx vitest run`（全量）— 39 个失败全部落在 `session.content-create` / `session.tab-*` 的 golden（并行 terminal-link 改动）以及两个与本功能无关的用例（mock-server-key-pair、mobile-agent-launch-architecture）；`files.explorer-screen` golden 通过。
- `node mobile/scripts/check-tests-typecheck-ratchet.mjs` — **失败**，其中 2 个新增文件属于本需求。
- `pnpm run check:code-quality:changed` — **失败**，本需求文件有 9 个新增 finding（其余为并行改动）。
- `npx oxlint --config config/oxlint-code-quality-native-plugins.json --deny-warnings <feature files>` — 失败（`mobile-file-save.ts` 的重复 import 会让根 `pnpm lint` 也失败）。

---

## BLOCKER

### B1. 新增测试文件使 mobile test typecheck ratchet 失败

`node mobile/scripts/check-tests-typecheck-ratchet.mjs` 报：

- `src/files/MobileFilePreviewScreen.actions.test.tsx`（`:139`、`:217`）— `findAllByType('Pressable')` 传入字符串，`ElementType` 不匹配。
- `src/files/MobileFileSearchResults.test.ts`（`:41`、`:51`、`:61`、`:77`）— `mobileFileSearchNote` 的参数类型是 `ReturnType<typeof useMobileFileSearch>`（含 `retry`），而测试构造的 `MobileFileSearchState` 少了 `retry`。

失败场景：mobile CI `verify` 明确执行该 ratchet（`.github/workflows/mobile.yml:130-131`）；新测试文件不在 baseline 中，CI 必红。这不是并行改动（另外两个失败文件 `terminal-link-open-policy.test.ts` / `use-mobile-session-file-actions.test.ts` 才是）。

修复：

1. `MobileFileSearchResults.test.ts`：给 `state()` 补 `retry: () => {}`，或把 `mobileFileSearchNote` 的入参收窄为 `Pick<MobileFileSearchState, 'status' | 'legacyFallback' | 'truncated' | 'libraryTotalCount' | 'totalCount' | 'results'>`（纯格式化函数不需要整个 hook 返回值）。
2. `MobileFilePreviewScreen.actions.test.tsx`：按 `mobile-file-preview-retry.test.tsx` 的写法用 `findAll((node) => String(node.type) === 'Pressable')`，或给测试引入共享的 renderer 类型。不要把文件加进 `tests-typecheck-baseline.txt`。

### B2. changed-code quality gate 失败（本需求 9 个新增 finding）

CI 在 PR 上执行 `pnpm run check:code-quality:changed`（`.github/workflows/pr.yml:257`）。本需求新增：

| 文件:行 | 规则 | 说明 |
|---|---|---|
| `mobile/src/files/mobile-file-save.ts:6` | `import/no-duplicates` | 第 6、9 行各自从 `./mobile-file-download-cache` import 一次。根 `pnpm lint` 用 `--deny-warnings` 也会失败。合并 import 即可。 |
| `mobile/src/files/mobile-file-download-cache.ts:274` | `typescript/consistent-type-assertions` | `parsed as Partial<CacheMetadata>` 没有 SAFETY 依据。后续字段检查虽已覆盖，但规则要求行内 disable + `SAFETY:`，或用运行时 guard 替代断言。 |
| `mobile/src/files/file-download-naming.ts:9` | unused `oxlint-disable` | `BIDI_CONTROLS` 的正则并未触发 `no-control-regex`；删除该指令。 |
| `mobile/src/files/MobileFileExplorerPanel.tsx:104-107` | `react-doctor/no-adjust-state-on-prop-change` | 4 条。`useEffect` 在 `hostId/worktreeId` 变化后清空搜索/分类/菜单状态。 |
| `mobile/src/files/use-mobile-file-search.ts:111` | `react-doctor/no-derived-state-effect` | 查询变化后在 effect 里同步 `setState`。 |
| `mobile/src/files/use-mobile-file-search.test.ts:26` | `typescript/consistent-type-assertions` | `as unknown as RpcClient`；请用带类型的最小 stub，或加行内 SAFETY disable。 |

修复建议（Panel）：在使用点给 panel 加 `key={`${hostId}:${worktreeId}`}`（路由页、`SessionDockColumn` 都适用），删除该重置 effect；或采用 `MobileFileMarkdownPreview` 里“渲染期比较上一个 prop”的写法。`use-mobile-file-search` 若确实必须由 effect 驱动异步查询，就加一条带理由的 `// oxlint-disable-next-line react-doctor/no-derived-state-effect -- ...`，否则把可派生的状态移出 effect。

---

## MAJOR

### M1. 搜索缓存/离线分支没有作废在途请求，旧查询结果会覆盖当前查询

`mobile/src/files/use-mobile-file-search.ts:111-154`

- 命中缓存时（`:130-134`）直接 `setState(cached)` 后 `return`，既没有 `sequenceRef.current += 1`，也没有清掉上一次查询留下的 `timerRef`。
- 离线分支（`:122-129`）同样不递增 sequence、不清 timer。
- 只有“无缓存的新查询”分支（`:135-138`）才递增 sequence。

具体失败场景（可稳定复现）：

1. 搜索 `app`，请求已发出（sequence=1）。
2. 退格/改成 `app2`，再改回 `app`（`app` 已在缓存）。effect 命中缓存并显示 `app` 的结果，但 sequence 仍是 1。
3. `app2` 的响应返回，`apply` 发现 `sequenceRef.current === sequence`，于是把 **`app2` 的结果写到当前 `app` 查询下**。用户点击结果会预览不匹配的文件。

离线时空格/离线状态也会被在途响应覆盖。修复：在 effect 顶部统一递增 sequence 并清 timer（或返回 cleanup 清 timer），让所有早退分支都作废旧请求。补一条 component test：缓存分支下旧请求不落地。

### M2. 旧主机回退把“显示上限 32”当作匹配总数

`mobile/src/files/use-mobile-file-search.ts:245-253`

`rankFileSearchPaths` 默认 `limit = 32` 且内部已经 `slice(0, limit)`（`:72`），随后 `totalCount: matches.length` 只能得到 ≤32。`mobileFileSearchNote`（`MobileFileSearchResults.tsx:81-85`）在未截断时输出 `Showing ${filteredCount} of ${search.totalCount} matches`。

失败场景：旧主机 `files.list` 返回 4000 个文件，查询 `app` 实际匹配 100 个。结果只返回 32 个，header 显示 **“Showing 32 of 32 matches”**，明确宣称已完整——这正是 D14/8.4 要求避免的“暗示已过滤全部”。同时 `truncated` 只看 `inventory.truncated`，不会因 100 > 32 而置位。

修复：让 ranking 返回 `{ paths, totalCount }`（或先用 `limit: Infinity` 计数再 slice），把真实匹配数写进 `totalCount`；当 `matches.totalCount > results.length` 时把 `truncated`/note 设为 “Showing first 32 of N matches”。补 >32 匹配的旧主机用例。

### M3. “文件库超过 2 万”提示永不可达；库截断被当成完整结果

`mobile/src/files/use-mobile-file-search.ts:218-221` 与 `MobileFileSearchResults.tsx:87-100`

- 新主机分支把 `libraryTotalCount` 赋成 `value.totalCount`（**匹配数**），而服务端的 `totalCount` 是 `rankRuntimeMobileFilePaths` 的匹配总数（`runtime-mobile-file-path-search.ts:123-150`），最多等于 20,000 的 inventory 上限。因此 `libraryTotalCount > 20000`（`:97`）永远为 false，设计 7.1 #7/D9 要求的 “File library exceeds 20,000 files; results may be incomplete.” 是一段死代码。
- 当 inventory 被 20k 上限截断、而查询只匹配 ≤32 个时，`truncated` 为 true、`totalCount === fetched`，`first` 输出 **“Showing first N of N matches”**，读起来仍是完整结果；空结果时甚至可能输出 “Showing first 0 of 0 matches”。

失败场景：25,000 文件的主机，查询 `zzz` 匹配 3 个；UI 显示 “Showing first 3 of 3 matches”，没有任何“库可能不完整”的提示，用户会认为不存在第 4 个匹配（实际 5,000 个文件没被扫描）。

修复：把“库是否被截断”与“匹配数是否超过 limit”分开。当前 wire 只有 `truncated`，可在 `totalCount <= results.length` 时判定为库截断，或（更干净）在 `RuntimeFileListResult` 增加可选 `libraryTruncated`（向后兼容）。至少要在 `truncated && totalCount <= fetched` 时输出 20k 提示，并为 D9 补测试。

### M4. `ready` 准备结果被无限复用，后续保存/打开会写入旧内容

`mobile/src/files/mobile-file-action-tasks.ts:84-87`

`startFileActionTask` 一旦看到 `status: 'ready'` 就直接返回旧的 `PreparedCachedFile`，没有任何 mtime/size/时效复核；而成功执行 Save/Open 后任务从不离开 `ready`（`use-mobile-file-actions.ts:84-87`），也没有 `done` 状态。

失败场景：对 `result.json` 点 Save（prepare 完成、SAF 保存）→ 桌面端修改该文件 → 再次 Save/Open。第二次直接分享/写入第一次的旧字节，结果页的 SHA-256 也是旧内容，且没有任何“文件已变化”的提示。设计 7.1 #12/7.3 要求每次下载前后校验、`ready → saving/sharing → done | error`；实现缺少 done/invalidations。清理设置页“Clear download cache”后同样会留下指向已删除文件的 ready 状态。

修复：Save/Open 完成后丢弃 ready 状态（保留缓存目录供 24h 分享，用 `deletePreparedCacheFile` 之外的“forget”方法）；或在复用前重新 `stat` 校验 size/mtime。`clearDownloadCache` / LRU 淘汰时应同时清理对应的 ready 状态。

### M5. 下载/保存/打开主链路完全没有单元测试

`mobile-file-prepare.ts`、`mobile-file-copy-content.ts`、`mobile-file-save.ts`、`platform/share-file.ts`、`platform/open-file.ts` 在生产代码中被 `mobile-file-action-tasks.ts` / `use-mobile-file-actions.ts` 调用，但没有任何测试文件直接覆盖它们（`rg` 只找到 `mobile-file-action-tasks.test.ts`，且它 mock 掉 `prepareFileForAction`）。

因此以下 FB-Q1/Q3 断言目前是空的：

- 分块写入、`bytesRead`/`eof`/最终 size·mtime 校验、取消后临时目录删除；
- `SAF_MAX_BYTES` 的 15.9/16/16.1 MB 分支（B19）与 >16 MB 分享回退；
- 终端文本/图片预算、grant 刷新后再读取；
- `safeLocalFileName` 在 prepare/save 中的实际使用、SAF 重名、hash 一致性；
- `fileActionCapabilities()` 的真实探测（见 C6）。

失败方式：把 prepare 的最终校验删掉、或把 16 MB 分支写反，现有测试仍然全绿。建议至少补 mock RPC + mock expo-file-system 的单测；设备用例 B1-B23 之外，这些是能在 CI 里跑的部分。

---

## MINOR

### m1. read-failure 状态被不读取的动作清除/制造

- `use-mobile-file-actions.ts:137-148`：`copyPath` 成功后调用 `succeed`，而 `succeed`（`:66-72`）会 `clearFileReadFailure`。失败场景：一个 EACCES 文件显示 “Read failed”，用户长按 → Copy path，徽标立即消失，尽管从未成功读取；违反 8.9 “EACCES/EPERM/ENOENT 只在 Retry 成功后清除”。
- `use-mobile-file-actions.ts:49-60`：任何非 `FileActionError` 的异常都被包装成 `read_failed` 并写入 registry。剪贴板写入失败、`Sharing.shareAsync` 抛出的原生错误都会让可读文件被标记 “Read failed”。
- `MobileFilePreviewScreen.tsx:151-158` 记录的是规范化后的 “Waiting for desktop...”；`file-read-failures.ts:25-60` 的 `classifyFileReadFailure` 不认识该文案（也不认识 “Unable to load preview” 的超时），于是归为 `other`，重连时不会被 `clearNetworkFileReadFailures` 清掉。场景：离线时打开预览 → 返回列表 → 重连，行仍显示 Read failed（A13 要求断线/超时在重连时清除）。

修复：只让 save/open/copy-content 的成功清除徽标；把原始错误（或 `status: 'waiting'` 的 `reconnect` 标志）传给分类器，并把 “waiting for desktop” 归入 network；非读取阶段的原生错误不要标成 `read_failed`。

### m2. 分享面板被取消仍报告 “Saved to phone”

`mobile-file-save.ts:23-25,30-32` 把 iOS（任意大小）和 Android >16 MB 的保存交给 `expo-sharing`；`expo-sharing` 的 `shareAsync` 在系统面板被 dismiss 时同样 resolve（其 iOS completion handler 对 `type == nil && !completed` 也 `promise.resolve(nil)`）。随后 `use-mobile-file-actions.ts:86-87` 无条件 `setSaveResult` + “Saved to phone”，并展示 SHA/路径。

失败场景：iOS 点 Save to phone → 面板里点 Cancel → 仍出现“Saved to phone”结果页。设计 8.1 的文案应只用于确实写入；share 分支无法确认落盘。建议区分 `kind: 'shared'`：提示 “Shared / check your Files app” 而不是 “Saved to phone”，或至少不要展示确定性成功的结果页。

### m3. 缓存元数据文件名可能与真实文件名冲突

`mobile-file-download-cache.ts:14,93-106,259-262`

缓存目录里的载荷文件名来自 `safeLocalFileName(requestedName)`；元数据固定叫 `.orca-download.json`。若目标文件本身名为 `.orca-download.json`（dotfile 会被 `safeLocalFileName` 保留，且 explorer 会列出它），`completedCachedFile` 会在写入载荷后把同一个文件覆盖成 JSON 元数据。结果：`prepared.uri` 指向元数据，分享/保存出去的是 JSON，而结果页 SHA 是载荷的 SHA。

修复：把元数据放到与载荷不同的子目录，或使用用户文件名不可能得到的保留名（例如目录同级的 `meta/`），或显式拒绝/改名该保留名。

### m4. prepare 进行中仍可重复触发 Save/Open

`use-mobile-file-actions.ts:74-119` 没有把 `task.state.status === 'preparing'` 暴露给 sheet/进度条用于禁用；`buildFileActions` 也不感知进行中。设计 3.3 “同一文件下载中禁用重复下载按钮”。场景：点 Save（prepare 中）→ 重新打开 `…` → 再点 Save：两次 `save()` 共享同一个 prepare promise，完成后依次调用 `savePreparedFileToPhone`，可能弹出两次 SAF 目录选择/分享面板。

修复：在 hook 返回 `busy`，预览/列表把 Save/Open/Cancel 置灰（或让 sheet 的 onAction 在 preparing 时忽略重复的同 target 请求）。

### m5. 跨屏失败时 Retry 按钮是死的

`file-action-tasks` 的失败状态是跨屏共享的（`useFileActionTask` 按 target key 订阅），但 `useMobileFileActions.retry` 依赖本 hook 实例的 `lastActionRef`（`use-mobile-file-actions.ts:45,152-158`）。在列表发起 Save 失败后进入该文件的预览页，进度条会显示 shared 的 failed 状态和 Retry 按钮；此时预览页的 `lastActionRef` 为 null，点 Retry 无任何动作（设计 7.3 要求列表/预览共享重试）。

修复：把 `lastAction` 存进共享 task state，retry 直接按 `task.state.action` 重放；或让 retry 接受 action 参数。

### m6. 触控目标小于 44×44

设计 7.1 #14 要求所有触控目标 ≥44×44 或 hitSlop：

- `MobileFileFilterChips.tsx:47-48` chip `minHeight: 32`，Pressable 无 `hitSlop`。
- `MobileFilePreviewHeader.tsx:37-44` terminal Save 36×36 且无 `hitSlop`（旁边的 overflow 有 `hitSlop={8}`，back 也有）。

修复：chip 加 `hitSlop={{ top: 6, bottom: 6 }}` 或 `minHeight: 44`；Save 加 `hitSlop={8}`。

### m7. 深链/文件链接打开的二进制预览会提供违规的 Copy content

`mobile-file-preview-action-target.ts:74` 对 worktree target 固定 `fileTargetKindForPath(relativePath, 'text')`。PDF/zip 等 `classifyMobileArtifact` 返回 `other` 且无 media，于是 kind 变成 `text`；在预览 context 的 sheet 里会显示 “Copy content”（矩阵要求 PDF/二进制没有该动作）。正常从列表进入时 `targetForRow` 传的是服务端 kind，问题只出现在 `mobile-file-tap-open`/深链进入的预览。修复：预览 target 依据路径分类并把无法预览的二进制默认成 `binary`（或复用列表的 kind 解析）。

### m8. LRU 测试名与断言相反

`mobile-file-download-cache.test.ts:55-62` 测试名是 “keeps the newest entry even when it alone is over the cap”，断言却是 `toEqual(['newest'])`（即删除 newest）。实际行为在“单文件超过 cap”时淘汰它是正确的（且 256 MB 单文件上限使其不可达），但名称会误导后续维护者，也会掩盖真正的边界意图。改名为 “evicts the only entry when it alone exceeds the cap”。

### m9. 死代码 / 误导性注释

- `mobile-file-explorer-styles.ts:70,84` 的 `rowDisabled`/`rowTitleDisabled` 在拆分 `previewDisabled`/`rowDisabled` 后已无引用。
- `mobile-file-actions.ts:12,145` 的 `FileActionTargetKindWithoutDirectory`、`fileActionLabel`；`mobile-file-action-tasks.ts:168` 的 `getFileActionTasksVersion`；`use-mobile-file-actions.ts:47` 的 `capabilityNotice`；`mobile-file-preview-route.ts:116` 的 `mobileFilePreviewShellParams`（native-only 路由后只剩测试使用）均为生产未用。
- `mobile-file-explorer-row.tsx:136-138` 的注释称 “RN fires onPress after onLongPress”，但 RN `Pressability` 在 `onLongPress` 已派发时会取消 `onPress`；600 ms 的 guard 是多余的，且会吞掉用户在 600 ms 内关闭弹层后的第一次点击。
- `mobile-file-actions.ts:149-156` 的 `terminalArtifactTooLarge` 作为类型谓词只在 `size` 超限时返回 true，导致 `buildFileActions` 的 false 分支把 `size` 未定义的终端 target 类型收窄成 `WorktreeFileActionTarget`（`:128` 访问 `previewable`）。当前运行时无害，但类型不安全，建议改成普通布尔判断 + 显式 `target.source === 'worktree'`。

### m10. 发布门禁未落地（FB-T1/T11/8.13）

- `mobile/app.json` 的 `version`（0.0.51）/`buildNumber`（1）/`versionCode`（18）未变更；新增 `expo-sharing`、`expo-intent-launcher` 需要 prebuild/store rebuild，设计 8.13 要求更新版本号。
- 设计 7.4/8.13 要求 Save/Open 有 feature flag 可回滚；实现只有能力探测（原生模块存在与否），没有远程/本地开关，回滚只能靠发新包。
- 设计 8.2 要求 grant 刷新后仍复制用户可见路径——已实现并有单测；但 `prepareFileForAction` 的 grant 刷新没有把刷新后的 source 回传屏幕（`startFileActionTask` 没有转交 `onTerminalArtifactSourceRefreshed`），后续 header Save/再次 Save 仍用旧 grant（虽然各操作会自行刷新，功能上可用）。

---

## 已核对且未发现问题的关键点

- 动作数组/顺序：文本、Markdown/HTML、图片、媒体、PDF/二进制、目录、终端文本/图片、终端超预算、readFailed、preview context 省略 Preview、能力缺失降级，均与设计 7.2/A10 一致（`mobile-file-actions.ts`、`mobile-file-actions.test.ts`）。
- 终端 >512 KB 不可达截断：本地 `readLocalTerminalArtifactFileFromHandle`（`runtime-file-commands-terminal-file-paths.ts:55-57`）与远端 relay（`fs-handler-terminal-artifact.ts:114-121`）都会抛 `file_too_large`，客户端 sheet 因而只保留 Copy path。客户端 `prepareTerminalArtifact`/`readTerminalText` 没有独立检查 `preview.truncated`，但当前服务端契约下不是可达的数据截断（建议作为防御性 hardening 顺手补上）。
- 16 MB SAF 边界、>16 MB 分享回退、256 MB 上限、384 KB 分块、stat/mtime/ctime 前后校验、取消删除临时目录：实现与 8.3/8.7 一致（缺测试见 M5）。
- 文件名安全化（路径分隔符、`..`、控制字符、bidi、255 字节、dotfile、无扩展名）与 MIME/UTI 映射：与 7.1 #13 一致，测试覆盖较好。
- 能力探测：`requireOptionalNativeModule` + 动态 import 的旧二进制降级路径成立；`ExpoSharing`/`ExpoIntentLauncher`/SAF/`File.contentUri` 名称与 expo 55 包一致；`contentUri`/FileProvider cache 路径存在。
- Markdown `textSelectionMode="document"` 不改动 chat-transcript 的 Android 行为，新增 Android 单测能捕获“误用 rangeSelectable”的实现。
- OTA：文件浏览/预览路由已强制 native；`shell-switch-build-kind`/route 测试同步更新；旧 golden 的替换是 UI 变化导致的合法更新。
- 读失败 registry 为模块级、跨面板/预览共享；预览成功后清除、行徽标/Retry 存在（分类问题见 m1）。
- 搜索：120 ms 防抖、limit 32、`files.searchPaths` 的 `method_not_found`/`forbidden` 回退、5000 清单、懒加载树过滤（未加载保留、已加载空目录隐藏、祖先保留）与 PDF 归 Docs 均符合 8.4；问题在 M1/M2/M3。
- 文件路由的强制 native、设置页 Clear cache、启动孤儿清理、24h/512 MB LRU 的纯函数与触摸/可访问性主体（行 44×44、长按/… 双入口、haptics）基本符合设计；细节见上。

## 合并建议

1. 先修 B1/B2（两处 CI 门禁 + `mobile-file-save.ts` 的重复 import），这是当前唯一确定会红 CI 的部分。
2. 修 M1/M2/M3（搜索竞态与截断文案），并补对应 hook/组件测试。
3. 修 M4（done/invalidations）与 M5（prepare/save 单测），这两项直接关系到“保存/打开的是不是当前文件”。
4. 其余 MINOR 可在同一 PR 或后续 PR 处理；m2/m3 属于用户可见的正确性，建议不要留到后续。
