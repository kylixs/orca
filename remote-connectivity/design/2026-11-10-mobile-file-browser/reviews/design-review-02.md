# 设计评审 02 — 移动端文件浏览

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`ui-prototypes/file-actions.html`（当前修订版），并对照 `2026-11-10-mobile-html-open-modes/`、移动端现有文件树/预览/媒体下载/搜索/OTA 代码与 RPC 契约。

结论：REJECTED

Findings 统计：BLOCKER 0 / MAJOR 11 / MINOR 12。

> 复审基线：`design.md`、`test-plan.md`、`tasks.md` 为 00:47 版本；原型在复审过程中于 01:06 更新，本报告以当前磁盘版本为准。

---

## 1. 总体判断

评审 01 的两个 BLOCKER（Android 保存落点、Android ACTION_VIEW）已在设计层用 SAF 与 `expo-intent-launcher` 解决，方向和 API 均可行；17 个 MAJOR 中大部分已闭环。剩余问题集中在四类：

1. **设计承诺了实现无法直接兑现的行为**：Markdown 渲染段落在 Android 上被 `rangeSelectable` 的聊天转录分支反向禁用；文件行“Read failed”没有数据来源；旧主机 `files.list` 回退并非全量（上限 5000）。
2. **动作模型自相矛盾**：`Download` 只写 cache、`Save to phone` 才写用户可见位置，但原型与 FB-B1 把两者混为一谈；终端产物的“复制/分享”与“下载/保存”范围在 7.1 与 7.2 之间冲突，且缺少实现任务。
3. **跨需求/OTA 风险未闭环**：HTML 渲染选择与 HTML 需求抽取 `MobileHtmlPreviewFrame` 的任务冲突；旧二进制（OTA JS）缺少原生模块能力探测机制。
4. **测试仍可放过错误实现**：若干用例保留了被 7.x 节推翻的旧预期（D3、D5、A1、A2、B6、iOS 可选），且缺少读失败、旧二进制、grant 过期、过滤上限提示等用例。

因此本轮仍不满足 G3 出口条件。

---

## 2. Prior findings（评审 01 逐条核对）

### 2.1 BLOCKER

| ID                       | 结论       | 证据                                                                                                                                                                                                                                           |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-B1 Android 保存落点    | **已解决** | `design.md:269-273` 将 SAF `requestDirectoryPermissionsAsync` + `createFileAsync` 定为正式路径，下载/分享拆分；`tasks.md:62` FB-T5；`test-plan.md:142` FB-B11、`:144` FB-B13；原型 10/11。遗留大文件写入见 M11。                               |
| P-B2 Android ACTION_VIEW | **已解决** | `design.md:274-277` 首期加入 `expo-intent-launcher` + `File.contentUri` + `FLAG_GRANT_READ_URI_PERMISSION`，无 Activity 回退分享；`tasks.md:63` FB-T6；`test-plan.md:143` FB-B12；原型 12。`expo-sharing` 的 `UTI`/`anchor` 经查是官方支持项。 |

### 2.2 MAJOR

| ID                                     | 结论         | 证据                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-M1 二进制行 disabled                 | **已解决**   | `design.md:278-280` 拆分 `previewDisabled`/`rowDisabled`；`tasks.md:68` FB-U8；`test-plan.md:152` FB-R7；原型 06。                                                                                                                                                                                            |
| P-M2 FileActionTarget 无法表达终端产物 | **部分解决** | 联合类型已补（`design.md:281-287`），FB-T10/FB-Q6 已加；但联合类型缺少 `worktreeId` 与 grant 刷新输入，且下载/保存无实现任务（见 M5）。                                                                                                                                                                       |
| P-M3 OTA 路由未决                      | **部分解决** | 7.1 #5 明确强制 native，FB-U7 改为明确任务（`design.md:288-290`、`tasks.md:84`）；旧二进制降级仍无机制与用例（见 M9）。                                                                                                                                                                                       |
| P-M4 无权限状态无数据源                | **未解决**   | 原型仍在文件树行上显示 `.env → Read failed`（`file-actions.html:423-428`、`:876-913`），但 `readDir` 返回的 `MobileDirEntry` 只有 name/isDirectory/isSymlink（`mobile/src/files/file-tree.ts:6-10`），没有 stat/权限字段；`design.md:332` 只写“重试提示”，没有定义何时、由谁产生该状态，也没有任务（见 M2）。 |
| P-M5 搜索 limit 冲突                   | **已解决**   | `design.md:293-297` 固定 ≤32；`FilePathSearch.limit.max(32)`（`src/shared/rpc-contract/files-params.ts:16`）；FB-S6；FB-D8。                                                                                                                                                                                  |
| P-M6 totalCount/truncated 未读取       | **已解决**   | 7.1 #7 要求新 reader 读取；`tasks.md:72` FB-S6；FB-D8/D9。                                                                                                                                                                                                                                                    |
| P-M7 top-N 后过滤漏结果                | **部分解决** | 设计/原型已明确“过滤只作用于前 32 条”（`design.md:296`、`file-actions.html:1197-1198`）；但测试计划没有一条用例断言该提示（FB-D6 只写“同时满足”），见 M10。                                                                                                                                                   |
| P-M8 过滤隐藏目录导致悬空              | **部分解决** | 7.1 #8 已定义保留祖先/隐藏空目录（`design.md:298-301`），原型 02 正确；但该规则只对已加载目录成立，懒加载树未定义（见 M8）。                                                                                                                                                                                  |
| P-M9 HTML 渲染视图选择被推迟           | **部分解决** | 7.1 #6 纳入本期，FB-U11、FB-A11、原型 17 均已补；但实现落点与 HTML 需求的 `MobileHtmlPreviewFrame` 抽取冲突（见 M3）。                                                                                                                                                                                        |
| P-M10 选择复制无状态原型               | **已解决**   | 原型 17 补选区/手柄/Copy/Select All；`ui/README.md:9-27` 明确英文文案规范。                                                                                                                                                                                                                                   |
| P-M11 动作可用性矩阵不完整             | **已解决**   | `design.md:319-332` 类型×动作矩阵；原型 03-08 覆盖文本/图片/媒体/PDF/二进制/终端产物。                                                                                                                                                                                                                        |
| P-M12 预览页下载无进度承载             | **已解决**   | 7.3 统一状态机；FB-U9、FB-B14；原型 14/15。                                                                                                                                                                                                                                                                   |
| P-M13 重试语义不可测                   | **部分解决** | 7.1 #12 明确不做续传、从头重试（`design.md:309-311`），原型 15 一致；但 FB-B6 仍写“重试可继续或明确从头开始”，见 M10。                                                                                                                                                                                        |
| P-M14 临时文件生命周期不可执行         | **部分解决** | 7.1 #11 补独立目录/LRU 512MB/启动清理/设置页清除；但保留时长仍是“延迟清理（或保留到下次启动/LRU）”，原型却写死 24 小时，FB-B15 无精确断言（见 M6）。                                                                                                                                                          |
| P-M15 测试无 AC 映射/平台边界          | **部分解决** | `test-plan.md:125-153` 已有 AC→用例矩阵，iOS 在 5.3 改为必过；仍有旧用例矛盾与缺失用例（见 M10）。                                                                                                                                                                                                            |
| P-M16 任务缺原生配置/发布/回滚         | **部分解决** | 补了 FB-T5..T10、FB-Q6/Q7、6.3 风险表；仍无旧二进制能力探测任务、无明确的版本号/商店发布任务（见 M9、m4）。                                                                                                                                                                                                   |
| P-M17 共享菜单依赖未登记               | **已解决**   | `tasks.md:83` 明确菜单/分享/打开由本需求提供；HTML 7.1/HT-U15 只允许追加。遗留：FB-U11 应指向 `MobileHtmlPreviewFrame`（见 M3）。                                                                                                                                                                             |

### 2.3 MINOR

| ID                           | 结论            | 说明                                                                                                                         |
| ---------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| P-m1 旧主机回退弱            | **部分解决**    | 改为复用 `files.list` 全量清单（`design.md:297`、FB-S8、FB-D11），但实际 `files.list` 上限 5000（见 M7）。                   |
| P-m2 排序/匹配文案不一致     | **已解决**      | 7.1 #8 明确匹配完整相对路径与 basename；FB-S7 补高亮；原型 `<mark>`。                                                        |
| P-m3 长按可发现性不足        | **已解决**      | 7.1 #14 + FB-U10：行尾“…”入口、`triggerMediumImpact`、44px/hitSlop；原型行尾按钮。                                           |
| P-m4 下载/打开命名近似       | **未解决/回退** | 从两个面板变成 `Download` + `Save to phone` + `Open with` 三个动作，语义更混乱（见 M4）。                                    |
| P-m5 文件名安全化/边界       | **已解决**      | 7.1 #13 + FB-T9；原型未逐项演示，但任务明确。                                                                                |
| P-m6 MIME/UTI 映射不完整     | **部分解决**    | FB-T9 要求统一映射，但 design 未给出表，也无测试断言代码文件回退 `text/plain`（见 m12）。                                    |
| P-m7 任务依赖小问题          | **已解决**      | 6.2 修正 T3 依赖、Q2 依赖；新增 Q6/Q7。                                                                                      |
| P-m8 设计缺用户流程/备选方案 | **未解决**      | `design.md` 仍无“用户流程”和“备选方案与取舍”章节（G1 要求，`DEVELOPMENT_PROCESS.md:88-95`），见 m1。                         |
| P-m9 原型主题/弹层形态       | **已解决**      | 主题 token #111111/#3b82f6/6px；菜单均为底部 ActionSheet；`ui/README.md:27`。                                                |
| P-m10 原型点击/头部 More     | **部分解决**    | 点击已改为进预览、头部 More 已删除（`file-actions.html:338` 等改为占位）；搜索结果行仍只有 toast，不打开预览/菜单（见 m2）。 |
| P-m11 原型无障碍尺寸/文案    | **已解决**      | chips/清除按钮 44px；英文文案 normative（`ui/README.md:5`）。                                                                |

---

## 3. Findings（本轮）

### BLOCKER

无。

### MAJOR

- **[MAJOR][M1] Markdown 渲染段落选择在 Android 上会被现有 `rangeSelectable` 语义反向禁用。**
  - 证据：`design.md:115-118` 计划给 `MobileMarkdown` 传 `rangeSelectable`；`mobile/src/components/MobileMarkdown.tsx:417-427` 在 `rangeSelectable && !INLINE_TEXT_SELECTION` 时置 `androidTranscript=true`；`mobile/src/components/MobileMarkdown.tsx:67-78` 在 `androidTranscript` 下把 `selectable===true` 强制改成 `false`；`mobile/src/components/inline-text-selection.ts:3-6` 明确 Android 返回 false。现有 `MobileFileMarkdownPreview.tsx:71-73` 还没传该 prop；按设计传下去后，Android 上段落、标题、列表、代码块都会变成不可选，FB-A5 必失败，并可能回归当前标题/代码块的可选行为。
  - 影响：需求 1（长按选中复制）在 Android 的 Markdown 渲染视图上不可达；设计给出的实现路径本身是反向的。
  - 修复：为文件预览增加独立的 `nativeTextSelection`/`selectableText` 语义，不要复用聊天转录的 `androidTranscript` 分支；或在 `MobileMarkdown` 中把“聊天转录”显式作为 prop（而非由平台推断）。补单测：Android 传入该 prop 后段落 `selectable=true`，聊天转录仍 `false`；设备用例覆盖 A5（含 CJK/emoji/折行）。

- **[MAJOR][M2] “Read failed / 无权限”行状态仍无数据来源，评审 01 的 M4 未闭环。**
  - 证据：`file-actions.html:423-428`、`:876-913` 仍把 `.env` 行渲染为 `Read failed`；`design.md:332` 只写“重试提示”；`mobile/src/files/file-tree.ts:6-10` 的 `MobileDirEntry` 没有 size/权限/错误字段，`:60-107` 只从 `readDir` 缓存展开；`design.md`/`tasks.md` 没有 stat-on-row 或失败缓存的任务；`test-plan.md` 没有对应用例。
  - 影响：实现者无法在不逐行 stat 的情况下得到该状态；若按原型实现，要么每行发一个 `files.stat`（大目录性能风险），要么伪造状态。原型的“行内 Read failed + Retry”会成为不可复现 UI。
  - 修复：明确二选一并写进任务：(a) 行级状态只在用户尝试预览/长按准备后产生，面板维护 `readFailures: Map<relativePath, message>`，行显示失败徽标 + Retry（重试成功后清除）；或 (b) 长按时先 `files.stat`，失败即显示该行状态。定义错误码映射（EACCES/EPERM/ENOENT/断线），补 FB 用例（stat 403 → 行徽标 → Retry 成功；断线 → 重连后清除）。

- **[MAJOR][M3] HTML 渲染选择的实现落点与 HTML 需求的受控 Frame 抽取冲突，且 7.1 #6 与 7.2 的 HTML 行表述不一致。**
  - 证据：`design.md:291-292` 说 HTML 渲染视图文字选择纳入本期；`design.md:327` 矩阵却写“HTML ✅（源码；渲染见 HTML 需求）”；`tasks.md:71` FB-U11 直接改 `MobileHtmlPreview`；同批 HTML 需求 `design.md:217-224` 要求抽 `MobileHtmlPreviewFrame`（HT-U6）、`tasks.md:27` HT-V1 才把渲染 body 接进文件预览；`tasks.md:83` 还规定“文件浏览先合并、HTML 再扩展”。若按此顺序，FB-U11 修改的 `MobileHtmlPreview` 会被 HT-U6 覆盖或产生两套实现。
  - 影响：两个子代理并行或按 FB→HT 顺序开发时，HTML 文字选择会丢失/重复；原型 17 宣称的“渲染 HTML 选区”在本需求内没有独立交付路径。
  - 修复：FB-U11 依赖改为 `HT-U6`（以及 `HT-V1`），实现目标改为 `MobileHtmlPreviewFrame`；明确顺序：FB 菜单/预览 → HTML Frame/渲染 → FB 文字选择；在 7.2 HTML 行补一句“渲染视图由 HTML 需求 HT-V1 提供；选择由 FB-U11 在其后追加”；把原型 17 标注为“依赖 HTML 需求交付”，FB-A11 同样标注跨需求前置。另：7.2 的“Orca 浏览器”列与 HTML 需求 7.3（本期不提供）冲突，应删除或标 P2/非目标。

- **[MAJOR][M4] `Download`、`Save to phone`、`Open with` 三个动作语义重叠，且 FB-B1 的预期只有 `Save to phone` 能满足。**
  - 证据：`design.md:139-148` 规定先写 app cache，再“保存到用户可见位置”；`design.md:269-273` 把下载与分享拆成两个动作；原型菜单同时提供 `Download`（`file-actions.html:477`、`:623`、`:671`、`:718`、`:765`、`:817`、`:865`）和 `Save to phone`（`:478`、`:624`、`:672`、`:719`、`:766`、`:818`、`:866`）；进度横幅明说 “Preparing cached copy”（`:1116`），但没有 `ready` 状态/后续 Save 入口；`test-plan.md:44` FB-B1 却要求“下载 10 KB 文本 → 文件可在系统文件/分享面板找到”。
  - 影响：用户点 `Download` 后文件只进 app cache，系统文件管理器里找不到；若把 `Download` 实现成 SAF，则与 `Save to phone` 完全重复。FB-B1 会放过“只写 cache”的错误实现，或要求实现一个与菜单语义不符的行为。
  - 修复：二选一并在 design/原型/测试统一：(a) 删除用户菜单里的 `Download`，把 `Save to phone` 定义为唯一“下载到手机”动作（Android SAF / iOS Save to Files），`Download` 仅作为内部 prepare；或 (b) 保留 `Download` 但定义为“prepare + 自动进入 Save 流程”，并补 `ready` 横幅（Save/Open/Cancel）与原型状态。FB-B1 改为断言 `Save to phone` 后的系统文件可见性与哈希；另加“仅点 Download 不产生用户可见文件”的显式断言（若选 a）。

- **[MAJOR][M5] 终端产物目标模型仍不足以实现 grant 刷新与下载/保存；7.1 #4 与 7.2/原型范围冲突；移动端 10 MB 图片上限超过实际 RPC 预算。**
  - 证据：`design.md:281-287` 的 terminal target 只有 `absolutePath/grantId/displayPath/name/kind/size`，缺 `worktreeId`、`pathText`、`cwd`、`terminalHandle`、`nativeChatContext`；现有 `mobile/src/files/mobile-terminal-artifact-grant-refresh.ts:9-18` 证明刷新必须这些字段，`mobile/src/files/mobile-file-preview-request.ts:78-99` 的 RPC 参数需要 `worktree: id:${worktreeId}`。`design.md:281-287` 写“本期仅支持文本 ≤512 KB、图片 ≤10 MB 的复制/分享”，`design.md:331` 与原型 07/08（`file-actions.html:813-821`、`:861-868`）却提供 Download/Save/Open。`tasks.md:12` FB-T3 只覆盖 worktree 的 stat/chunk，`tasks.md:67` FB-T10 只写 target/grant，没有“artifact 文本/图片写入 cache”的任务。`src/shared/remote-runtime-memory-limits.ts:8` 的移动端出站 JSON 上限 4 MB，`src/main/runtime/runtime-file-commands-revoke-terminal-file-grants-for-client.ts:93-126` 的 artifact preview 受 `maxContentBytes` 限制，实际可预览图片约 3 MB，不是 10 MB。
  - 影响：按当前 union 实现无法调用 `files.readTerminalArtifact`/`resolveTerminalPath`；终端产物的 Download/Save 无任务、无缓存落盘方案；5–10 MB 的终端图片在移动端会直接 `file_too_large`，与原型 08 和 7.1 #4 的“≤10 MB”不符；grant 过期无测试。
  - 修复：把 terminal target 扩为 `{ source:'terminalArtifact'; worktreeId; absolutePath; grantId; pathText?; cwd?; terminalHandle?; nativeChatContext?; displayPath; name; kind:'text'|'image'; size?; readOnly? }`；新增“artifact prepare”任务：文本用 `readTerminalArtifact`，`truncated=true` 时禁止 Download/Save、只允许 Copy 并提示“已复制前 512 KB”；图片解码 base64 写 cache，并按真实 `remoteFileContentBudget`（约 3 MB）而不是 10 MB 判定，超限提示“请在桌面端处理”；补 grant 过期刷新、超预算图片、截断文本、Copy path=pathText 的用例；统一 7.1 #4 与 7.2/原型的动作范围。

- **[MAJOR][M6] 下载缓存保留策略仍未决策，原型写死 24 小时，FB-B15 无法判错。**
  - 证据：`design.md:306-308` 仍写“分享后延迟清理（或保留到下次启动/LRU 配额）”，是两个未选择的方案；原型 12/13 明确 “Orca keeps the cached copy for 24 hours”（`file-actions.html:1026`、`:1079`）；`test-plan.md:146` FB-B15 只写“延迟清理策略生效”，`:63` FB-C5 写“按策略清理”。
  - 影响：实现者可以选“下次启动清理”，在系统面板关闭后立即删除，导致目标 App 异步读取失败；B15 仍会通过。评审 01 的 M14 没有真正闭环。
  - 修复：在 design 7.1 #11 选定一个可执行策略（建议：分享/ACTION_VIEW 后至少保留 24h；每次下载唯一目录；512 MB LRU；启动时清理孤儿；设置页“清除下载缓存”）；FB-B15 改为可断言：分享面板关闭后 5 分钟仍能读取；24h 后（或 LRU 触发/清理后）文件不存在；FB-C5 断言取消后临时文件在 24h 保留期内仍可被目标 App 读取、之后清理。

- **[MAJOR][M7] 旧主机搜索回退并非“全量”：`files.list` 上限 5000，且现有 inventory reader 丢弃 totalCount/truncated。**
  - 证据：`design.md:297` 写“复用 ... files.list 全量清单”；原型 16 与 `file-actions.html:1173`、`:1221` 写 “full files.list inventory search”；`test-plan.md:151` FB-D11 写“全量清单回退”；实际 `src/main/runtime/runtime-file-commands-mobile-file-list-limit.ts:15` `MOBILE_FILE_LIST_LIMIT = 5000`，`src/main/runtime/runtime-file-commands-constructor.ts:54-79` 截断并返回 `truncated`；`mobile/src/session/mobile-session-read-operations.ts:129-137` 复用 `workspaceFilePathsSchema`，`mobile/src/session/session-read-reply-schema.ts:57-66` 只取 relativePath，totalCount/truncated 被丢弃。
  - 影响：5000 文件以上的旧主机工作区，搜索会静默漏结果；原型/测试会让实现者以为已经全量。与 7.1 #7 对 20k 截断的严谨态度不一致。
  - 修复：新增/泛化一个保留 `totalCount`/`truncated` 的 inventory reader；结果头显示“Showing first 5000 / results may be incomplete”；FB-D11 改为 >5000 文件用例并断言提示；同步修改 design 7.1 #7、原型 16 文案（不要写 full）。

- **[MAJOR][M8] 懒加载树上的类型过滤语义未定义：未加载目录既不能判定为空，也不能安全隐藏。**
  - 证据：`design.md:298-301` 要求“保留匹配文件的祖先目录，隐藏空目录”；`mobile/src/files/file-tree.ts:60-107` 只展开 `expanded` 且已缓存的目录，未加载目录没有子项信息；原型 02 使用一棵已全部加载的静态树（`file-actions.html:528-572`），并据此隐藏 `session`；`test-plan.md:150` FB-D10 只覆盖“嵌套目录”，没有“未加载目录”。
  - 影响：实现者若按“逐行隐藏空目录”，会把未加载但可能含匹配的目录隐藏；若保留未加载目录，则“空目录隐藏”的断言不成立。过滤器在真实懒加载树上的行为无法从设计推出。
  - 修复：在 7.1 #8 明确：未加载目录一律保留并标记“not loaded”（或点击 chip 时按需加载全部目录）；只对已加载且无匹配后代的目录隐藏；补 FB-D10 变体：未加载目录 + 已加载空目录 + 已加载有匹配目录三种情况，断言树层级与提示。

- **[MAJOR][M9] 旧二进制/OTA 安全降级仍无实现机制、任务和可失败的用例。**
  - 证据：`design.md:288-290` 要求旧二进制（无新原生模块）不显示下载/打开动作、保留复制路径；`design.md:341-345` 承认原生模块需要重建；`tasks.md:84` FB-U7 只写“OTA 测试与旧二进制降级提示”；`test-plan.md:86` FB-R6 只写“新功能可用或有明确提示”。`expo-sharing`/`expo-intent-launcher` 目前不在 `mobile/package.json`（`mobile/package.json:32-40`），一旦 OTA JS 更新到旧二进制，静态 `import` 会在模块加载时因缺少原生模块抛错（Expo 的 `requireNativeModule`），而不是优雅隐藏动作。
  - 影响：这是 OTA 构建的正常状态，不是边缘场景；最坏情况是旧二进制打开文件页即崩溃。FB-R6 的“或有提示”会让任何实现通过。
  - 修复：新增 capability 模块，用 `requireOptionalNativeModule` 或 try/catch 的动态 `import` 探测 `ExpoSharing`/`ExpoIntentLauncher`；不可用时隐藏 Download/Save/Open，只保留 Copy path/Copy contents，并显示“Update Orca on this device to use file actions”；FB-R6 改为断言 OTA 构建下文件路由走 native、动作集合按能力隐藏、旧二进制不崩溃；补一个 mock 缺失模块的组件/单测和一条旧二进制真机用例。

- **[MAJOR][M10] 测试计划仍保留被 7.x 推翻的旧预期，且缺关键用例，错误实现可以通过。**
  - 证据与冲突：
    - `test-plan.md:71` FB-D3 仍写“回退已加载目录过滤”，与 `:151` FB-D11“files.list 全量清单回退”矛盾；
    - `:73` FB-D5 只列“代码/文档/图片/其它”，设计 7.1 #8 与原型（`file-actions.html:347-353`）有 Media 六类；
    - `:30` FB-A1 的动作列表缺 `Save to phone`，与原型 03（`file-actions.html:622-627`）和 7.1 #1 不一致；
    - `:31` FB-A2 仍要求目录菜单有“展开/折叠”，原型目录动作只有 Copy path（`file-actions.html:1294`、`:1303`）；
    - `:49` FB-B6 仍写“重试可继续或明确从头开始”，与 7.1 #12“不做续传、从头重试”矛盾；
    - `:16` 仍允许 iOS“记录未覆盖”，与 `:157` “iOS 模拟器必过项”矛盾；
    - `:86` FB-R6 的“可用或有明确提示”不可判错（见 M9）。
      另外缺少：读失败/无权限行（M2）、旧二进制降级（M9）、终端产物 grant 过期（M5）、过滤受 32 条上限限制的提示（P-M7）、搜索 loading/离线、长按后释放不触发预览。
  - 影响：G1 的“验收标准可测试”不成立；这些用例会把已否决的行为当作通过标准。
  - 修复：按 7.x 重写 D3/D5/A1/A2/B6，删除 line 16 的 iOS 例外；为上述缺失项各加一条可断言用例（具体动作列表、具体文案、具体状态）；FB-R6 改为断言 native 路由 + 动作集合。

- **[MAJOR][M11] Android SAF 保存大文件没有可行写入路径；256 MB 上限与 `writeAsStringAsync` 的整串写入不兼容。**
  - 证据：`design.md:143-144` 只写“SAF createFileAsync 写入”，`design.md:156` 上限 256 MB；`test-plan.md:142` FB-B11 只用 18.2 MB，且没有大文件保存用例；`mobile/node_modules/expo-file-system/build/legacy/FileSystem.d.ts:343` 的 `createFileAsync` 只创建文件，`StorageAccessFramework` 的写入别名是 `writeAsStringAsync`（`:345-363`）；`mobile/node_modules/expo-file-system/build/legacy/FileSystem.types.d.ts:267-276` 的 `copyAsync` 目标文档为 `file://` URI，源码 `FileSystemLegacyModule.kt:298-340` 对 `from.scheme === 'file'` 直接 `toUri.toFile()`，不能把 cache 文件复制到 SAF `content://`。
  - 影响：100–256 MB 文件若用 `writeAsStringAsync`（base64）保存，需要在 JS 构造百 MB 级字符串，极易 OOM/ANR；设计承诺的“大文件可保存”在 Android 上没有落地机制。
  - 修复：明确大文件保存路径：(a) 设定 SAF 保存专用的较小上限（如 32–64 MB），超过则提示“请在桌面端保存”；或 (b) 新增原生流式复制/MediaStore 写入能力（需单独任务与原生模块）；补一条接近上限的真机保存用例（哈希 + 文件管理器可打开），并在 FB-B11 中覆盖重名/扩展名（`createFileAsync` 的 fileName 不含扩展名）。

### MINOR

- **[MINOR][m1] G1 要求的“用户流程”和“备选方案与取舍”章节仍未补。** `design.md` 只有现状/目标/方案/组件/风险/AC；`DEVELOPMENT_PROCESS.md:88-95` 明确要求。补两节：列表长按、预览菜单、搜索、下载/保存、打开、失败/取消的逐步流程；以及为什么不用 HTTP 下载 URL/桌面中转、为什么选 SAF/Intent、为什么本期不做分页。
- **[MINOR][m2] 原型搜索结果只弹 toast，不打开预览或操作菜单。** `file-actions.html:1200-1219` 的 `result-main` 和行尾“…”都只有 `data-toast`；没有 `data-preview-view` 或 sheet 绑定；caption `:1221` 却写“Tap to preview · long-press or … for actions”。至少把结果行接到预览、把“…”接到 `data-file-sheet`，或明确状态 16 是静态示意。
- **[MINOR][m3] 原型新增的“保存成功结果页”未进入设计/任务；同时终端产物预览页缺少现有 Save。** `file-actions.html:953-985` 的结果页在 design/tasks 中没有对应任务；`:790-805`、`:843-852` 的终端产物预览头部只有 File actions，没有现有可编辑产物的 Save（`mobile/src/files/MobileFilePreviewScreen.tsx:250-259`），而 `design.md:94` 说“替换/补充现有 Save”。补任务/状态，或删掉结果页；终端产物状态应同时展示 Save 与溢出菜单，并在 FB-R4 断言保存未回归。
- **[MINOR][m4] 任务/依赖仍有过期文字。** `tasks.md:10` FB-T1 仍写“如需 Android 直接打开再加 expo-intent-launcher”，与 `design.md:274-277` 的“首期加入”矛盾；`tasks.md:25` FB-U7 仍标“依赖 评审决策”，决策已定；缺少明确的原生模块版本号/商店构建/发布验证任务（6.3 只是风险行）。
- **[MINOR][m5] 搜索框形态与搜索 loading/离线态未定。** `design.md:171` 仍写“点击展开，或常驻”；原型常驻；`design.md:181` 要求无结果/加载/错误态，但原型没有搜索 loading/错误/离线状态，FB-D4 只写“空态/错误态正常”。选定常驻搜索，并补 loading/离线/重试视觉与可断言文案。
- **[MINOR][m6] 从文件行/搜索结果点“复制内容”没有“已加载内容”来源。** `design.md:123` 说复制“当前已加载内容”，`design.md:89` 与原型 03 又把它放进文件行菜单；行菜单此时没有预览内容。定义按需 `files.read`（≤512 KB，截断提示）或只在预览页提供；同步 FB-A7。
- **[MINOR][m7] 长按与点击互斥未写进设计/任务，也无测试。** 原型 `file-actions.html:1446-1467` 用 `longFired` 防止长按后释放再进预览，这是正确做法；`tasks.md:19` 只写“行 onLongPress”，FB-A1 只断言菜单出现。补“长按后释放不得同时打开预览”的用例与实现要求（含 Android）。
- **[MINOR][m8] 单飞/共享进度状态的归属未定义，列表侧进度也未原型化。** `design.md:337` 要求同一 target 单飞、文件页与预览页共享进度/取消/重试；`tasks.md:69` FB-U9 只写 hook；原型只有预览页进度（`file-actions.html:1113-1117`），没有列表发起的下载进度；没有重复下载/跨页单飞用例。明确用模块级 registry/context 承载，补列表进度状态与“同文件重复下载被拒绝”的测试。
- **[MINOR][m9] 目录长按动作三处不一致。** `design.md:95` 写“复制路径/展开/折叠”，原型 `file-actions.html:1294`/`:1303` 只保留 Copy path，`test-plan.md:31` FB-A2 又要求展开/折叠。统一为“复制路径（+ 点击行展开/折叠）”，或补菜单动作并更新原型/测试。
- **[MINOR][m10] 平台/分类小文案与组件能力不一致。** 原型通用菜单的 `Save to phone` 提示写“Folder picker”（`file-actions.html:478`、`:624` 等），iOS 实际是分享面板/“Save to Files”；`ActionSheetModal`（`mobile/src/components/ActionSheetModal.tsx:110-144`）没有内建 Cancel，而 `design.md:91` 要求“取消”；`design.md:300` 把 pdf 归入 Docs，原型 `matchesChip`（`file-actions.html:1394-1396`）把 pdf 归入 Other。按平台调整副文案、明确 Cancel 作为 action、统一 pdf 分类。
- **[MINOR][m11] 旧主机搜索回退只写 `method_not_found`，会漏掉 `forbidden`。** `design.md:176`/`:297` 与 FB-D3 只提 `method_not_found`；现有 `mobile/src/transport/mobile-method-unavailable.ts:1-11` 明确旧桌面 allowlist 也可能返回 `forbidden`，并已有 `isMobileMethodUnavailableError`。改用该 helper（两种 code + “not available to mobile clients”），并在 FB-D3 覆盖两种 refusal。
- **[MINOR][m12] MIME/UTI 表未落文，代码文件回退无测试。** `design.md:314` 只写“统一 MIME/UTI 映射”，`tasks.md:66` FB-T9 要求，但没有表；`.ts/.tsx` 若用 octet-stream，Android 可能没有 Activity。补一张表（至少 png/jpg/gif/webp/pdf/zip/mp4/mp3/md/txt/ts/tsx/html + UTI），并单测 `text/plain` 回退与未知类型提示。

---

## 4. Requirement coverage

| 用户需求                            | 覆盖情况                                                                                                                                  | 结论                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1. 长按选中复制文字                 | 文本/代码已有 `<Text selectable>`；Markdown 设计传 `rangeSelectable` 但 Android 会被反向禁用；HTML 渲染选择依赖 HTML 需求且任务落点冲突   | **部分覆盖，Android Markdown 不成立** |
| 2. 下载/保存到手机                  | Worktree RPC 分块 + cache 可行；Android SAF 方向正确，但 `Download` 与 `Save to phone` 语义重叠、SAF 大文件写入未落地、终端产物下载缺任务 | **部分覆盖**                          |
| 3. 用手机 App 打开                  | Android ACTION_VIEW/contentUri/flags、iOS share sheet/UTI/anchor 均可行；旧二进制降级无机制，终端产物图片上限超出移动端预算               | **部分覆盖**                          |
| 4. 搜索/过滤                        | limit/truncated/祖先目录已设计；旧主机回退实际 5000 上限被误称全量，懒加载树过滤未定义，测试仍有旧预期                                    | **部分覆盖**                          |
| 5. 不回归现有预览/媒体/终端编辑/OTA | 设计有回归 AC；原型终端产物状态缺 Save，OTA 旧二进制缺降级，FB-R6 不可判错                                                                | **部分覆盖**                          |

---

## 5. 建议修改顺序（G3 前）

1. 先修设计层矛盾：M4（Download/Save 语义）、M5（终端 target/范围/预算）、M6（缓存策略）、M7（5000 上限）、M8（懒加载过滤）、M3（HTML 落点/顺序）。
2. 再修实现可行性：M1（Android Markdown 选择）、M2（读失败数据源）、M9（旧二进制能力探测）、M11（SAF 大文件）。
3. 最后重写测试计划：M10 + 缺失用例（读失败、旧二进制、grant 过期、32 条过滤提示、search loading/离线、长按/点击互斥、列表侧进度/单飞）。
4. 原型同步：m2/m3/m9/m10（搜索结果动作、Save 按钮、目录动作、iOS 副文案/取消/pdf 分类），以及 M4/M5/M6 的菜单与状态。

---

## 6. 待确认问题

1. 用户需要的“下载到手机”是否等同于“保存到用户可见位置”（Android SAF / iOS Files）？若同意，建议删除单独的 `Download` 菜单项，避免第三个语义。
2. 终端产物本期是否真的需要 Download/Save/Open，还是只做“复制（≤512 KB 文本）+ 分享小文件”？若需要下载，是否接受按移动端 ~3 MB 的 RPC 预算而不是 10 MB？
3. 旧二进制 OTA 是否作为必须支持的发布形态？若是，能力探测与降级必须进入本需求任务与真机用例。
4. SAF 保存是否接受 32–64 MB 的专用上限（超过引导桌面端），还是必须支持 256 MB（需新增原生流式写入）？
5. 过滤 chip 是否保留 Media 六分类，且 PDF 是否归入 Docs（与原型 Other 冲突）？
