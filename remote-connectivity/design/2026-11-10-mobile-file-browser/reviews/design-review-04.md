# 设计评审 04 — 移动端文件浏览

范围：`design.md`（第 8 节为规范）、`test-plan.md`、`tasks.md`、`ui/README.md`、`ui-prototypes/file-actions.html`（Playwright 静态 + 交互检查），并对照 `DEVELOPMENT_PROCESS.md`、同批 HTML 需求与移动端现有文件树/预览/终端产物/RPC 代码。

结论：REJECTED

Findings 统计：BLOCKER 0 / MAJOR 1 / MINOR 4。

> 复审基线：`design.md` / `tasks.md` 为 01:46 版本，`test-plan.md` 为 01:47 版本，`ui/README.md` 为 01:53 版本，原型为 01:55 版本；移动端源码以当前分支为准。

---

## 1. 总体判断

评审 03 的 2 个 MAJOR 中，M2（header Save）在规范、原型和 README 层面已正确收敛；M1（终端文本 >512 KB）在 7.1、8.2、原型 07b、测试 B10、任务 FB-T4B 中均已改为 “Too large for mobile; open on desktop” + 仅 Copy path。14 个 MINOR 中 12 个已闭环，2 个仅部分闭环（m8、m11），m12 的任务状态仍停留在 review-03。

但 `design.md` 3.3 的终端产物数据获取条目仍保留旧的“截断时可 Copy content/路径”描述，与本轮已确认的“现有 RPC 直接 `file_too_large`，不承诺截断读取”直接冲突。这是 review-03 M1 的同类问题，且位于实现者会照着做的数据获取小节，因此本轮仍不能给出 APPROVED。

---

## 2. Review-03 逐条核对

### 2.1 MAJOR

| ID                  | 结论                       | 证据                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 终端文本 >512 KB | **部分解决**               | 规范侧已改：`design.md:292`（7.1 #4）、`:383`（8.2）、`:349`（7.2 终端文本 ≤512 KB）、`ui/README.md:16`、`test-plan.md:66` B10、`tasks.md:15` FB-T4B、原型 07b（`file-actions.html:964-1008`）均为 too-large + Copy path。**残留**：`design.md:136`（3.3 终端产物数据获取）仍写“截断时只允许 Copy content/路径，禁用 Save/Open 并提示”，见 3.1。 |
| M2 header Save      | **已解决（测试证据待补）** | `design.md:387` 明确只用于“可编辑文本 + 未保存修改”，图片/只读/超预算不渲染；`ui/README.md:15`、原型 07（`file-actions.html:910-962`）一致；Playwright 确认 07 有 header Save，07b/08/08b 均无。测试未断言该条件，见 3.5。                                                                                                                       |

### 2.2 MINOR

| ID                        | 结论                      | 说明                                                                                                                                                                       |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1 Copy content 来源      | **已解决**                | `design.md:124` 改为按需读取；`test-plan.md:43` A7；`tasks.md:33` FB-U6；原型 03 说明（`file-actions.html:758`）不再暗示只复制已加载文本。                                 |
| m2 MIME/UTI 表            | **已解决**                | `design.md:320-332` 已落表；`test-plan.md:78` B22 覆盖表项、`text/plain` 回退与未知类型。                                                                                  |
| m3 LRU/16 MB 测试         | **已解决**                | `design.md:393`；`test-plan.md:75-76` B19/B20；测试数据 `:130`。                                                                                                           |
| m4 Copy path 语义         | **已解决**                | `design.md:385`；`test-plan.md:51` A15；原型 07/07b/08 均写 `pathText ?? displayPath`。                                                                                    |
| m5 legacy `totalCount`    | **已解决（设计/任务层）** | `design.md:398` 明确 `legacyFileListSchema`/`mobile-file-explorer-operations.ts`；`tasks.md:53` FB-S8；现有 schema 尚未实现，属 G4 范围。                                  |
| m6 Q7 归属                | **已解决**                | `design.md:424` 交叉 builder/菜单测试归 HT-Q7；`mobile-html-open-modes/tasks.md:53` HT-Q7 确实覆盖，FB-Q7 只做无障碍/触控。                                                |
| m7 ENOENT/重连            | **已解决**                | `design.md:431` 重连只清断线/超时，EACCES/EPERM/ENOENT 需 Retry；`test-plan.md:49` A13；原型 09/交互 01 文案一致。                                                         |
| m8 保存结果页             | **部分解决**              | 任务/测试已补（`tasks.md:40` FB-U13、`test-plan.md:77` B21），但 `design.md:377` 仍称“可选”，FB-U13 仍保留“或移除原型结果页”，与 B21/原型 11 冲突，见 3.2。                |
| m9 列表侧进度             | **已解决**                | 原型 14b（`file-actions.html:1423-1459`）；`ui/README.md:42`；`test-plan.md:124` R10 覆盖列表/预览共享与单飞。                                                             |
| m10 失败后 Retry          | **已解决（已交互验证）**  | 静态 09（`:1130-1142`）正确；交互 01 的 `openFileSheet` 现在走 `isReadFailed`（`:2016-2030`），点击 `.env` 失败并返回后，行尾 `…` 菜单为 Retry read / Copy path / Cancel。 |
| m11 精确断言              | **部分解决**              | A3、D14 已改，但 A10 仍只写“符合动作矩阵”（`test-plan.md:46`），D14 的 “refine your search to see more” 在原型 16 中不存在，B9 的 toast 文案也未与设计/原型对齐，见 3.3。  |
| m12 任务状态/签名         | **部分解决**              | FB-T2 签名已改为 `buildFileActions(target, {context, htmlOpenMode?, capabilities})`（`tasks.md:11`），但状态行仍为 review-03 REJECTED/修订中（`tasks.md:3`）。             |
| m13 SAF/`contentUri` 能力 | **已解决**                | `design.md:404`、`tasks.md:14` FB-T4A、`test-plan.md:89` C6 均覆盖 SAF/`File.contentUri` 缺失与不静态崩溃。                                                                |
| m14 跨屏读失败 registry   | **已解决**                | `design.md:433` 要求模块级 registry/context；`tasks.md:39` FB-U12；`test-plan.md:49` A13 含“预览失败 → 返回列表 → 徽标 → Retry”。                                          |

---

## 3. Findings（本轮）

### BLOCKER

无。

### MAJOR

- **[MAJOR][M1 残留] `design.md:136` 仍承诺终端产物文本“截断”状态，且允许 Copy content，与本轮已确认的不可达状态冲突。**
  - 证据：`design.md:136` 写“文本：`files.readTerminalArtifact`，≤512 KB；**截断时只允许 Copy content/路径，禁用 Save/Open 并提示**”。同一文档的 7.1 #4（`:292`）和 8.2（`:383`）明确 `>512 KB` 现有 RPC 直接 `file_too_large`、不承诺截断读取、仅 Copy path；`test-plan.md:66` B10、`tasks.md:15` FB-T4B、`ui/README.md:16`、原型 07b 也都没有 Copy content。
  - 现有链路：本机在 `src/main/runtime/runtime-file-commands-terminal-file-paths.ts:55-57` 对 `size > MOBILE_FILE_READ_MAX_BYTES` 直接抛 `file_too_large`；SSH/relay 在 `src/relay/fs-handler.test.ts:225-235` 明确拒绝超限读取；`truncateMobileFilePreview`（`src/main/runtime/runtime-file-commands-terminal-artifact-access.ts:131-143`）只对已允许读入的 worktree 内容生效。因此 terminal artifact 的 `truncated=true` 永远不会出现，`design.md:136` 描述的“截断时可 Copy content”无法实现。
  - 影响：3.3 是“数据获取”的实现入口；实现者若按此条做，会再次产出 review-03 M1 的不可复现状态，或被迫改 host 契约。
  - 修复：把 `design.md:136` 改为“文本：`files.readTerminalArtifact`，≤512 KB；>512 KB host 返回 `file_too_large`，显示 ‘Too large for mobile; open on desktop’，只保留 Copy path，不读取/不截断”。同时把 3.1 `:89` 与 FB-U6 `tasks.md:33` 的“截断提示”限定为 worktree 文本，避免再次被读成 terminal 行为。

### MINOR

- **[MINOR][m8 残留] “文件已保存”结果页在三份产物之间仍是可选 vs 必须。**
  - 证据：`design.md:377` 写“toast + **可选**的‘文件已保存’结果页”；`tasks.md:40` FB-U13 仍写“保存结果页……**或移除原型结果页；二选一**”；但 `test-plan.md:77` B21 直接断言结果页，`ui/README.md:20` 称其为 “a real state”，原型 11（`file-actions.html:1191-1227`）也已画出。
  - 影响：按 design/FB-U13 可以合法删除结果页，但删除后 B21 必然失败；实现范围不确定。
  - 修复：在 8.1 把结果页定为必选（推荐，与原型/测试一致），并把 FB-U13 的“或移除”分支删掉；若产品决定只要 toast，则删除 B21 与原型 11，二选一。

- **[MINOR][m11 残留] 部分用例仍不是精确断言，且 D14 的文案与原型不一致。**
  - 证据：`test-plan.md:46` A10 仍只写“文本/Markdown/图片/媒体/HTML/PDF/二进制分别符合动作矩阵”，没有逐类型数组；`test-plan.md:109` D14 期望 “Showing first 32 of N matches; **refine your search to see more.**”，但原型 16（`file-actions.html:1534-1535`）和 `ui/README.md:44` 只有 “Showing first 32 of 148 matches” + “Filters apply to these first 32 results only.”，`design.md:397` 也只规定前者；`test-plan.md:65` B9 的 toast “Saved to phone” 在 design 8.1/原型 11 中没有对应文案。
  - 影响：D14/B9 会因文案不一致而假失败或诱导实现者写错文案；A10 仍可放过错误动作集合。`design.md:457` 自己要求“所有断言写具体动作数组、文案……”。
  - 修复：A10 逐类型列出完整数组（含 Cancel 位置）；D14 改用原型 16 的精确文案（或反向更新原型/8.4）；B9 明确 toast 文案并断言 header Save 仍为终端写回语义。

- **[MINOR][m12 残留] `tasks.md` 的状态行仍停留在 review-03。**
  - 证据：`tasks.md:3` 仍为“设计 review-03 REJECTED（2 MAJOR/14 MINOR 修订中，2026-11-10）”。签名问题已修（`:11`）。
  - 影响：任务板与实际评审轮次不一致，定时调度会误判当前门禁。
  - 修复：改为 review-04 的当前结论（或“review-04 复审中”），并在复审通过后更新为 APPROVED。

- **[MINOR][M2 测试证据] header Save 的“仅 dirty 可编辑文本”条件没有进入测试方案。**
  - 证据：`design.md:387`、`ui/README.md:15`、原型 07 均规定 header Save 只在“可编辑文本 + 未保存修改”出现，图片/只读/>512 KB 不渲染；但 `test-plan.md:118` R4 只写“预览页 Save 与溢出菜单并存”，`test-plan.md:67-68` B11/B12 只断言 sheet 动作，未断言 header Save 不存在；`tasks.md:30` FB-U3 也只写“终端产物页保留 Save”，没有 dirty 限定。
  - 影响：现有 `MobileFilePreviewScreen.tsx:250-259` 对“可编辑但未修改”的终端文本仍渲染禁用 Save（`canSaveArtifact` 在 `:187-197` 才要求有草稿），实现者可能保留该按钮，违反 8.2/原型；测试无法发现。
  - 修复：R4 增加“dirty 可编辑文本显示 header Save；clean/图片/只读/>512 KB 不显示”；B10/B12 补 header Save 缺失断言；FB-U3 写明“仅 dirty 渲染”。

---

## 4. Requirement coverage

| 用户需求                            | 覆盖情况                                                                                  | 结论                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1. 长按选中复制文字                 | 文本/代码/Markdown 有明确选择语义；Markdown Android 使用 document 模式；HTML 交给 Frame   | **覆盖**；继续保留真机 A5/A9 证据                    |
| 2. 下载/保存到手机                  | 唯一 Save to phone、prepare-only、24h、SAF ≤16 MB、>16 MB 分享回退、终端产物任务均已成立  | **基本覆盖**：M1 残留与结果页可选性是仅剩的文档冲突  |
| 3. 用手机 App 打开                  | Android ACTION_VIEW/contentUri/flags、iOS 分享/UTI/anchor、旧二进制降级均有设计/任务/测试 | **覆盖**；C6 已含 SAF/contentUri                     |
| 4. 搜索/过滤                        | 32/5000/20k、totalCount/truncated、懒加载过滤、method_not_found/forbidden 均已定义        | **覆盖**；D14 文案需对齐                             |
| 5. 不回归现有预览/媒体/终端编辑/OTA | 回归 AC、R1-R12、终端 Save、旧二进制矩阵已列                                              | **部分覆盖**：header Save 的 dirty 条件缺测试（3.5） |

---

## 5. 原型验证记录

用 Playwright（Chromium）加载 `file-actions.html` 做静态与交互检查：

- 静态 frames：
  - header Save 只出现在 07 `file-artifact-text`（dirty）；07b、08、08b 均为空。
  - 07b 可见动作：Copy path、Cancel；08b 相同。
  - 03 文本顺序：Preview、Save to phone、Open with、Copy content、Copy path、Cancel。
  - 04 图片/05 媒体/06 PDF 动作与矩阵一致，均无 Download。
  - 09 失败行菜单：Retry read、Copy path、Cancel。
  - 14b 有列表侧进度横幅 + Cancel；11 有 saved-result（路径、SHA-256、24h）；16 结果头 “Showing first 32 of 148 matches”；16b “Showing first 5000; results may be incomplete”。
- 交互：
  - 01 点击 `.env` 后进入失败预览并写行徽标；返回列表后行尾 `…` 菜单为 Retry read / Copy path / Cancel（m10 已修）。
  - 16 点击结果行打开预览；行尾 `…` 打开同一 sheet，动作为 Preview / Save to phone / Open with / Copy content / Copy path。
- 未发现原型与 8.2 的 Save 单一入口、终端 header Save 状态、07b/08b 动作集合冲突。

---

## 6. 建议修改顺序

1. 修 `design.md:136` 的终端“截断 → Copy content”残留（一行），并顺手限定 3.1/FB-U6 的截断语义为 worktree。
2. 决定保存结果页是否必选；建议按原型/测试定为必选，删掉 FB-U13 的“或移除”。
3. 精确化 A10/D14/B9，直接使用原型 16/11 的文案与完整动作数组。
4. 更新 `tasks.md:3` 状态。
5. 补 header Save 的 dirty/absent 测试断言与 FB-U3 文案。
6. 复审（review-05）只需核对上述 5 点与原型未回归。

---

## 7. 待确认问题

1. “文件已保存”结果页是否确定为必选？当前 design 8.1/FB-U13 说可选，B21/原型 11 说必须有。建议定为必选。
2. header Save 在“可编辑但未修改”时是隐藏（设计/原型）还是保留禁用（现有代码）？若按设计隐藏，需要在 FB-U3/R4 中明确为行为变更。
