# 设计评审 03 — 移动端文件浏览

范围：`design.md`（以第 8 节为准）、`test-plan.md`、`tasks.md`、`ui/README.md`、`ui-prototypes/file-actions.html`（Playwright 交互检查 + 静态检查），并对照 `DEVELOPMENT_PROCESS.md`、同批 HTML 需求与移动端现有文件树/预览/搜索/终端产物代码。

结论：REJECTED

Findings 统计：BLOCKER 0 / MAJOR 2 / MINOR 14。

> 复审基线：`design.md` / `test-plan.md` / `tasks.md` 为 01:15 版本，原型为 01:30 版本；移动端源码以当前分支为准。

---

## 1. 总体判断

评审 02 的 11 个 MAJOR 在结构上已基本闭环：唯一 `Save to phone`、prepare-only、24h 缓存、SAF ≤16MB + 分享回退、终端产物目标模型、Markdown 新选择语义、读失败缓存、旧二进制能力探测、5000 清单上限、懒加载过滤、HTML Frame 归属与顺序、iOS 必过，以及测试中的旧预期，均已写入设计/任务/测试或原型。

但本轮仍不满足 G3 出口条件，原因是两处**设计与现有实现/原型直接冲突**：

1. 终端产物文本“>512KB 截断”状态在现有 RPC 下不可达（本机与 relay/SSH 都会直接返回 `file_too_large`），因此原型 07b 与测试 B10 的“Copy first 512KB”无法实现。
2. 原型在终端图片（08/08b）和截断文本（07b）上保留了 header `Save`，但设计只保留“现有 Save（可编辑产物）”；图片与截断产物不可编辑，现有代码不会显示该按钮。它要么是一个未定义动作，要么与“唯一 Save to phone”重复。

---

## 2. Review-02 逐条核对

> 下表的 M*/m* 指评审 02 的条目；第 3 节出现的 M*/m* 为本轮新条目，按上下文区分。

### 2.1 MAJOR

| ID                        | 结论         | 证据                                                                                                                                                                                                             |
| ------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Markdown Android 选择  | **已解决**   | `design.md:394-398`（8.6）新增 `textSelectionMode`/document 语义；`tasks.md:32` FB-U5；`test-plan.md:41` A5 明确段落/标题/列表/代码可选。                                                                        |
| M2 读失败行状态           | **已解决**   | `design.md:413-417`（8.9）定义 `readFailures`、错误码映射、Retry/重连清除；`tasks.md:39` FB-U12；`test-plan.md:49` A13；原型 09 明确“动作后产生”。跨屏写入机制未指定见 m14。                                     |
| M3 HTML Frame 落点/顺序   | **已解决**   | `design.md:407-411`（8.8）；`tasks.md:38` FB-U11 依赖 HT-U6/HT-V1；`test-plan.md:47` A11；原型 17 标注跨需求。遗留 FB-Q7 文案见 m6。                                                                             |
| M4 Download/Save 语义     | **已解决**   | `design.md:359-365`（8.1）删除 Download；`tasks.md:29` FB-U2；`test-plan.md:37` A1、`:73` B18；原型所有 sheet 无 Download 动作（Playwright 检查 `downloadAction: []`）。                                         |
| M5 终端产物模型/范围/预算 | **部分解决** | 目标字段与 prepare 任务已补（`design.md:284-292`、`:367-373`；`tasks.md:15` FB-T4B、`:21` FB-T10；`test-plan.md:64-68` B9-B13）。但截断态不可达（M1），原型 header Save 错误（M2），Copy path 语义未定义（m4）。 |
| M6 缓存保留策略           | **已解决**   | `design.md:375-379`（8.3）固定 24h/512MB LRU/启动清理/设置页；`test-plan.md:70` B15、`:83` C5；原型 11/12/13/22。LRU/16MB 边界断言缺失见 m3。                                                                    |
| M7 旧主机 5000 上限       | **已解决**   | `design.md:381-386`（8.4）、`:302`；`tasks.md:52` FB-S8；`test-plan.md:101` D11；原型 16b。现有 reader 的 totalCount 缺口见 m5。                                                                                 |
| M8 懒加载树过滤           | **已解决**   | `design.md:385`；`tasks.md:51` FB-S7；`test-plan.md:100` D10；原型 02/02b 覆盖未加载/已加载空目录/祖先保留。                                                                                                     |
| M9 旧二进制能力探测       | **已解决**   | `design.md:388-392`（8.5）；`tasks.md:14` FB-T4A、`:22` FB-T11、`:34` FB-U7；`test-plan.md:84-85` C6/C7、`:115` R6。SAF/`File.contentUri` 探测覆盖见 m13。                                                       |
| M10 测试旧预期            | **已解决**   | D3/D5/A1/A2/B6/R6 已按 7.x 重写（`test-plan.md:37-38`、`:61`、`:93-95`、`:115`）；iOS 必过 `:13`、`:121` R12。精确数组/文案仍有小缺口见 m11。                                                                    |
| M11 SAF 大文件            | **已解决**   | `design.md:400-405`（8.7）≤16MB SAF、16-256MB 分享、>256MB 桌面提示；`tasks.md:16` FB-T5、`:13` FB-T4；`test-plan.md:58-60` B3-B5；原型 10/18/20。                                                               |

### 2.2 MINOR

| ID                        | 结论         | 说明                                                                                                                                                     |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1 用户流程/备选方案      | **已解决**   | `design.md:419-434`（8.10/8.11）。                                                                                                                       |
| m2 搜索结果交互           | **已解决**   | 原型 16/16b 结果行已接预览；`…`/长按打开同一 sheet。Playwright 验证：点击结果后 `data-preview-view` 从 hidden 变为可见，行尾按钮打开 `data-file-sheet`。 |
| m3 结果页/终端 Save       | **部分解决** | 结果页已入 8.1/原型 11，但仍无任务/测试（m8）；终端 Save 状态出现新错误（M2）。                                                                          |
| m4 旧任务文字/发布        | **已解决**   | `tasks.md:10`、`:22` 已改；T11 覆盖商店构建/OTA。                                                                                                        |
| m5 搜索框/加载/离线       | **已解决**   | 常驻搜索；`tasks.md:49` FB-S5、`:53` FB-S9；`test-plan.md:94` D4。                                                                                       |
| m6 Copy content 来源      | **未解决**   | `design.md:124` 仍写“复制当前已加载内容”，与 A7/FB-U6 的“按需读取”冲突（m1）。                                                                           |
| m7 长按/点击互斥          | **已解决**   | `design.md:421`；`tasks.md:28` FB-U1；`test-plan.md:48` A12、`:120` R11；原型 03 `longFired`。                                                           |
| m8 单飞/列表进度          | **部分解决** | 单飞已入 8.3/8.10、FB-U9、R10、原型 21；列表侧进度原型仍缺（m9）。                                                                                       |
| m9 目录动作一致性         | **已解决**   | `design.md:95`、8.10；`test-plan.md:38` A2；原型 01/02/02b 目录仅 Copy path。                                                                            |
| m10 平台副文案/Cancel/PDF | **已解决**   | 原型 13b iOS “Save to Files”；Cancel 作为 action；PDF 归 Docs（02b、`matchesChip` `file-actions.html:2117-2124`）。                                      |
| m11 旧主机 forbidden      | **已解决**   | `design.md:384`；`test-plan.md:93` D3；使用 `isMobileMethodUnavailableError`。                                                                           |
| m12 MIME/UTI 表           | **未解决**   | design 仍只有一句“统一映射”（m2）。                                                                                                                      |

---

## 3. Findings（本轮）

### BLOCKER

无。

### MAJOR

- **[MAJOR][M1] 终端产物文本“>512KB 截断”状态在现有 RPC 下不可达，原型 07b 与测试 B10 无法通过。**
  - 证据：`design.md:292`（7.1 #4）、`:336`（7.2 终端文本）、`:370`（8.2）均承诺 `truncated` 时只读前 512KB、Copy content 可复制前 512KB；`test-plan.md:65` B10 直接断言该状态；原型 `file-actions.html:959-1005`（07b）展示截断预览、禁用 Save/Open、Copy content “Copies the first 512 KB”；`tasks.md:15` FB-T4B 也写“截断/超预算”。
  - 现有链路：移动端走 `files.readTerminalArtifact`（`mobile/src/files/mobile-file-preview-operations.ts:53-61`）。本机读取在 `src/main/runtime/runtime-file-commands-terminal-file-paths.ts:55-57` 对 `fileStat.size > 512KB` 直接抛 `file_too_large`；SSH/relay 的 `fs.readTerminalArtifact` 在 `src/relay/fs-handler.test.ts:225-235` 明确“rejects content beyond the requested byte limit”（实现入口 `src/relay/fs-handler.ts:187-192`）。`truncateMobileFilePreview`（`src/main/runtime/runtime-file-commands-revoke-terminal-file-grants-for-client.ts:82`）只处理已经被允许读入的内容，永远拿不到 >512KB 的文本。因此 `truncated=true` 不会出现，移动端实际收到的是 `file_too_large`；“复制前 512KB”没有数据来源。
  - 影响：07b 是不可复现 UI；B10 会失败；实现者若强行按原型做，只能伪造截断内容或改 host 行为。
  - 修复（二选一）：
    - (a) 最简单：把终端文本 >512KB 定义为 “Too large for mobile; open on desktop”（与图片超预算一致），只保留 Copy path；删除 07b、B10 的截断/Copy first 512KB 断言，并同步 8.2/7.2。
    - (b) 若确实需要截断：新增 host 侧“读取前 512KB 并返回 `truncated=true`”的能力（本机 + SSH/relay），新增 capability 协商/任务/测试，明确旧客户端收到 `truncated` 的兼容行为，再保留 07b/B10。不能只改 mobile 侧。
  - 同时检查 `test-plan.md:125` 的 511/512/513KB 数据只对 worktree `files.read` 有效，不适用于终端产物。

- **[MAJOR][M2] 原型在终端图片和截断文本上保留了 header `Save`，与设计“仅保留可编辑产物的现有 Save”及现有代码冲突。**
  - 证据：原型 08 图片 header 有启用 `Save`（`file-actions.html:1026`），08b 超预算图片 header 有禁用 `Save`（`:1072`），07b 截断文本 header 有禁用 `Save`（`:977`）；同时 sheet 内已经有 `Save to phone`（`:1044`、`:1091`、`:997`）。设计 `design.md:373` 明确“终端产物预览页保留现有 Save（**可编辑产物**）与溢出菜单”；8.1 又规定 `Save to phone` 是唯一用户可见保存动作（`design.md:361-365`）。现有 `isEditableMobileTerminalArtifactPreview`（`mobile/src/files/mobile-file-preview-editability.ts:7-22`）对图片、媒体、truncated 一律返回 false，`MobileFilePreviewScreen.tsx:249-259` 只在 `isEditableTerminalArtifact` 时渲染 header Save。
  - 影响：图片/截断产物的 header Save 没有现有行为可对应；若实现成“保存到手机”，它又是 sheet 内 `Save to phone` 的第二个入口，违反 8.1 的单一动作；若实现成“写回终端”，图片/截断内容不可编辑，语义不成立。07 的 header Save 还在未修改时显示为启用，而现有 `canSaveArtifact` 要求有未保存草稿（`MobileFilePreviewScreen.tsx:187-198`）。
  - 修复：header Save 只出现在“终端文本、未截断、可编辑、且有未保存修改”的状态；删除 08/08b/07b 的 header Save（07b 应由“不可编辑”直接不渲染，而不是禁用）。如果产品确实想要 header 保存入口，必须在 design/tasks/test 中把它定义为 `Save to phone` 的第二个入口并明确与 sheet 的关系，但不建议这样做。

### MINOR

- **[MINOR][m1] Copy content 的数据来源仍自相矛盾。** `design.md:124`（3.2）写“复制当前已加载内容”，但 `test-plan.md:43` A7 与 `tasks.md:33` FB-U6 都要求“按需读取 ≤512KB”；文件行菜单没有已加载内容。修复：把 3.2 改为“按需 `files.read`/`readTerminalArtifact`，≤512KB，截断提示”，并让原型 03 的说明（`file-actions.html:755`）不再暗示只复制已加载文本。
- **[MINOR][m2] MIME/UTI 表仍未落文。** `design.md:317-319` 只有“统一映射”；`tasks.md:20` FB-T9 要求表；`test-plan.md` 只测 B2/B7。补一张至少覆盖 png/jpg/gif/webp/pdf/zip/mp4/mp3/md/txt/ts/tsx/html 的表，并单测代码/纯文本回退 `text/plain`、未知类型 `application/octet-stream` 的提示。
- **[MINOR][m3] 缓存 LRU 与 16MB 边界没有可失败用例。** `design.md:378-379` 要求 LRU 清理最旧项；`test-plan.md:70` B15 只写“24h/清理后不存在”，B16 只写孤儿清理；`test-plan.md:125` 数据有 16MB，但 B1/B2/B3 没有 16MB 边界。补：填满 512MB 后最旧项被淘汰、最新项保留；15.9/16/16.1MB 分别走 SAF/分享分支。
- **[MINOR][m4] 终端产物 Copy path 的语义未定义。** `design.md:288-290` 同时有 `pathText` 和 `displayPath`；8.2 只说 Copy path；`test-plan.md:44` A8 只覆盖 worktree 相对路径。补：`Copy path = pathText ?? displayPath`，并在 grant 刷新（B13）后断言仍复制用户看到的 `pathText`。
- **[MINOR][m5] 旧主机 totalCount 保留没有落到具体 reader。** `design.md:302`/`:384` 要求读取 `totalCount`/`truncated`；`tasks.md:52` FB-S8 只写“inventory reader”；现有 `mobile/src/files/file-explorer-reply-schema.ts:41-44` 的 `legacyFileListSchema` 只保留 `truncated`，`mobile-file-explorer-operations.ts` 也以 `truncated` 为目标。补：在该 schema/reader 中保留 `totalCount`，并测 5000/5001。
- **[MINOR][m6] 8.8 的交叉测试归属与 tasks 不一致。** `design.md:410` 写“交叉测试由 HT-Q7/FB-Q7 覆盖”；`tasks.md:65` 的 FB-Q7 实际是“无障碍/触控/长按互斥/读屏”。修复：改为“由 HT-Q7 覆盖”，或把交叉 builder 测试加入 FB-Q7 并更新依赖。
- **[MINOR][m7] 读失败清除规则中 ENOENT 与“重连”绑定不正确。** `design.md:416` 写“重连后清除 ENOENT/断线类失败”；`test-plan.md:49` A13 只写“重连清除断线失败”。ENOENT 不会因重连而消失。修复：重连只清除断线/超时；EACCES/ENOENT 只在 Retry 成功后清除，并同步原型 09 的文案。
- **[MINOR][m8] “文件已保存”结果页仍无任务/测试。** `design.md:364` 允许结果页，原型 11 已画，但 `tasks.md` 无对应任务、`test-plan.md` 无断言。修复：加任务/组件测试，或在 design 标为可选并从原型移除。
- **[MINOR][m9] 列表侧进度/失败状态仍未原型化。** `design.md:440`（8.12）要求“补列表侧进度与失败状态”；原型 14/15/21 都是预览页，`ui/README.md:36` 也只描述预览页。修复：补一个从文件列表发起 Save 的横幅状态（含单飞/取消/失败），或明确列表复用预览同一横幅并截图证明。
- **[MINOR][m10] 交互原型 01 在失败后长按仍打开普通动作菜单，不显示 Retry。** Playwright 验证：点击 `.env` 后行徽标出现，但行尾 `…` 打开的是 Preview/Save/Open/Copy content/Copy path/Cancel，没有 `Retry read`；`design.md:415` 8.9 要求失败行长按菜单提供 Retry。静态 09 正确。修复：`openFileSheet` 检查 `data-fail`/readFailures 并走 Retry 分支，或把 01 标注为不演示失败菜单。
- **[MINOR][m11] 部分用例仍不是“精确断言”。** `test-plan.md:39` A3 只写“Save/Open/Copy path 可用”，`:46` A10 只写“符合动作矩阵”，`:104` D14 只写“显示提示”，`:64` B9 写“提示与桌面编辑的区别”。补：逐类型写出完整动作数组/Cancel 位置；D14 用原型 16 的精确文案；B9 写具体提示。
- **[MINOR][m12] 任务元数据/签名与同批 HTML 任务不一致。** `tasks.md:3` 仍是“设计修订 02（待复审）”；`tasks.md:11` FB-T2 是 `buildFileActions(target, capabilities)`，而 `2026-11-10-mobile-html-open-modes/tasks.md:29` HT-U4 是 `buildFileActions(target, {context, htmlOpenMode, capabilities})`。即使合并顺序是 FB 先、HTML 后，也应在 FB-T2 直接采用最终签名，避免实现后返工。
- **[MINOR][m13] 旧二进制能力覆盖只测 ExpoSharing/Intent，未测 SAF/`File.contentUri`。** `design.md:390` 明确探测 SAF；`test-plan.md:84` C6 只写“缺少 ExpoSharing/Intent”。补：mock `expo-file-system` 的 SAF/`File.contentUri` 不可用，断言隐藏 Save/Open 且不崩溃；同时覆盖 `expo-sharing`/`expo-intent-launcher` 的静态 import 不会在模块加载时抛错。
- **[MINOR][m14] 读失败缓存从预览页写回文件树面板的机制未指定。** `design.md:415` 8.9 说“面板维护 `readFailures`”，但预览是独立路由（`mobile/src/files/mobile-file-preview-navigation.ts`、`MobileFilePreviewScreen.tsx`），读取失败发生在面板之外；`tasks.md:39` FB-U12 只写“面板/行”，没有共享 store/回调。修复：明确模块级 registry/context 或路由回传，并补“预览失败 → 返回列表 → 行徽标出现 → Retry 清除”的组件用例。

---

## 4. Requirement coverage

| 用户需求                            | 覆盖情况                                                                                                  | 结论                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. 长按选中复制文字                 | 文本/代码/Markdown 有明确选择语义；Markdown Android 已改独立 `textSelectionMode`；HTML 由 HTML Frame 提供 | **覆盖**；A5/A9 需真机证据                                            |
| 2. 下载/保存到手机                  | 唯一 Save to phone、prepare-only、24h、SAF ≤16MB、>16MB 分享回退、终端产物任务均在设计层成立              | **部分覆盖**：终端文本截断态不可达（M1），终端 header Save 错误（M2） |
| 3. 用手机 App 打开                  | Android ACTION_VIEW/contentUri/flags、iOS 分享/UTI/anchor、旧二进制降级均有设计/任务/测试                 | **覆盖**；补 SAF/contentUri 能力 mock（m13）                          |
| 4. 搜索/过滤                        | 32/5000/20k、totalCount/truncated、懒加载过滤、method_not_found/forbidden 均已定义                        | **覆盖**；totalCount reader 需落地（m5）                              |
| 5. 不回归现有预览/媒体/终端编辑/OTA | 回归 AC、R1-R12、终端 Save、旧二进制矩阵已列                                                              | **部分覆盖**：终端 Save 态原型冲突（M2），列表侧进度原型缺（m9）      |

---

## 5. 原型验证记录

用 Playwright 加载 `file-actions.html` 做了只读检查：

- 文件列表 header 无 More；行尾 `…` 与长按均打开同一 sheet。
- 所有 sheet 中没有以 Download 开头的用户动作（`downloadAction: []`）；文本 sheet 顺序为 Preview、Save to phone、Open with、Copy content、Copy path、Cancel（隐藏的 Retry 不显示）。
- 搜索结果行点击后 `data-preview-view` 由 hidden 变为可见；行尾 `…` 打开 `data-file-sheet`；16/16b 的“Showing first 32 of N / first 5000”文案存在。
- 终端文本 07、截断 07b、图片 08、超预算 08b 的 sheet 禁用状态正确；但 header Save 在 07b/08/08b 存在（M2）。
- 交互 01 点击 `.env` 后徽标出现，但随后 `…` 菜单没有 Retry（m10）。
- PDF 在 02b 和 `matchesChip` 中归 Docs；13b iOS 副文案为 “Save to Files”；01 无 header More/行内大小标签。

---

## 6. 建议修改顺序（G3 前）

1. 先解决 M1：在“截断”与“超预算提示”之间做选择；若选截断，新增 host 能力任务与兼容测试；若选提示，删除 07b/B10 并同步 8.2/7.2。
2. 再解决 M2：按现有 `isEditableMobileTerminalArtifactPreview` 修正 07/07b/08/08b 的 header Save；同步 design 8.2 与 `ui/README.md`。
3. 修 m1-m14：Copy content 来源、MIME 表、LRU/16MB 边界、Copy path、totalCount、Q7、ENOENT、结果页、列表进度、交互 Retry、精确断言、任务元数据、SAF 能力、跨屏写回机制。
4. 重新跑原型交互检查与测试计划的可执行性检查（尤其 B10/B15/B3）。

---

## 7. 待确认问题

1. 终端文本 >512KB 是否必须支持“复制前 512KB”？若否，建议直接归入 “Too large for mobile; open on desktop”。
2. 终端产物的 header Save 是否只保留“可编辑文本的现有写回”？若是，图片/截断态必须移除该按钮。
3. 终端产物 Copy path 是否统一复制 `pathText ?? displayPath`？
4. 16MB SAF 边界是否作为独立验收点（15.9/16/16.1MB）？
