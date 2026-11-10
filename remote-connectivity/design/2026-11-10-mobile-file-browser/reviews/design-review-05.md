# 设计评审 05 — 移动端文件浏览

范围：`design.md`、`test-plan.md`、`tasks.md`、`ui/README.md`、`ui-prototypes/file-actions.html`（Playwright 静态 + 交互检查），并对照 `DEVELOPMENT_PROCESS.md` 与移动端现有文件/终端预览代码。

结论：APPROVED_WITH_MINORS

Findings 统计：BLOCKER 0 / MAJOR 0 / MINOR 3。

> 复审基线：`design.md` / `tasks.md` / `test-plan.md` 为 02:05 版本，`ui/README.md` 为 01:53 版本，原型 `file-actions.html` 为 01:55 版本；本次未修改任何受影响文件。

---

## 1. 总体判断

Review-04 的 1 个 MAJOR 与 4 个 MINOR 均已闭环：终端文本 >512 KB 的不可达“截断 + Copy content”状态已从 3.3 删除；保存结果页已定为必选并落到任务/B21；A10/D14/B9 已改为精确动作数组/文案；`tasks.md` 状态已更新；新增 B23 覆盖 header Save 的 dirty/absent 条件。

上一轮之前的所有 BLOCKER/MAJOR 未发现回归：SAF、ACTION_VIEW、二进制行、终端 target、OTA 降级、Markdown 选择、读失败缓存、HTML Frame 顺序、旧主机 5000 上限、懒加载过滤、16 MB 边界、缓存策略均仍在设计/任务/测试中成立。

剩余 3 个 MINOR 都是文档精度问题，不阻塞 G4；建议在进入开发前顺手修掉，避免测试/任务文本再次漂移。

---

## 2. Review-04 逐条核对

### 2.1 MAJOR

| ID | 结论 | 证据 |
|---|---|---|
| M1 终端文本 3.3 截断残留 | **已解决** | `design.md:136` 已改为 “≤512 KB；>512 KB 现有 RPC 返回 `file_too_large`，提示 ‘Too large for mobile; open on desktop’，仅保留 Copy path”；与 `design.md:292`（7.1 #4）、`:383`（8.2）、`ui/README.md:16`、`test-plan.md:66` B10、`tasks.md:15` FB-T4B 一致。Playwright 确认原型 07b 的 sheet 仅 `Copy path`、`Cancel`，无 header Save/Save to phone/Open with/Copy content。残留的泛化“截断提示”见 3.2（MINOR）。 |

### 2.2 MINOR

| ID | 结论 | 证据 |
|---|---|---|
| m8 保存结果页必选 | **已解决** | `design.md:377`（8.1）已写“随后显示保存结果页（路径、SHA-256、‘Cached copy kept for 24 hours’；同一 ActionSheet 流程）”，不再写“可选”；`tasks.md:40` FB-U13 已删除“或移除原型结果页”；`test-plan.md:77` B21 断言；`ui/README.md:20` 称其为 real state；原型 11（`file-actions.html:1195-1227`）已画出。 |
| m11 A10/D14/B9 精确化 | **已解决** | `test-plan.md:46` A10 已逐类型列出完整数组（含 Cancel）；`:110` D14 使用 “Showing first 32 of N matches”（N = totalCount）；`:65` B9 使用 “Saved to phone”，且 `design.md:377` 定义该 toast。A10 的终端数组与原型上下文仍有一处剩余差异，见 3.1。 |
| m12 任务状态 | **已解决** | `tasks.md:3` 已从 review-03 更新为 “设计 review-04 REJECTED（1 MAJOR/4 MINOR 已修订，2026-11-10；待复审）”。本轮通过后应更新为 review-05。 |
| M2 测试证据（header Save） | **已解决** | `test-plan.md:79` 新增 B23：“仅‘可编辑文本 + 有未保存修改’显示且启用；图片/只读/超预算/无修改不渲染”；`design.md:387`、`ui/README.md:15` 与原型 07/07b/08/08b 一致。Playwright 确认仅 07 有 header Save，07b/08/08b 均无。任务/回归文案仍有残留，见 3.3。 |

---

## 3. Findings（本轮）

### BLOCKER

无。

### MAJOR

无。

### MINOR

- **[MINOR][A10 终端数组与原型上下文不一致] `test-plan.md:46` 的终端文本/图片动作数组包含 Preview，但原型 07/08 的预览页溢出 sheet 没有 Preview。**
  - 证据：A10 写“终端文本：同文本；终端图片：同图片”，即包含 `Preview`。原型 07 的 sheet 动作是 `Save to phone / Open with / Copy content / Copy path / Cancel`（`file-actions.html:953-958`），08 是 `Save / Open / Copy path / Cancel`（`:1046-1050`），均无 Preview。原型交互函数在 `fromPreview` 时显式隐藏 Preview（`file-actions.html:1987`），而终端产物正是从预览页进入；`design.md:438`（8.10 #2）也写“预览页 `…`：同一 sheet”。
  - 影响：A10 会诱导实现者在终端预览页的溢出菜单里加一个冗余 Preview，或让正确实现（无 Preview）被判失败。
  - 修复：在 `design.md` 3.1/8.10 明确“预览页上下文隐藏 Preview（7.2 的 Preview 列只表示可预览能力）”，并把 A10 终端文本改为 `Save to phone、Open with、Copy content、Copy path、Cancel`，终端图片改为 `Save、Open、Copy path、Cancel`（终端超预算保持 `Copy path、Cancel`）。

- **[MINOR][截断提示仍无限定词] `design.md:89` 与 `tasks.md:33` 的“截断时提示”仍未限定为 worktree 文本。**
  - 证据：`design.md:89` 写“复制文件内容（文本/HTML，≤512 KB；截断时提示）”，`tasks.md:33` FB-U6 写“Copy content 按需读取 ≤512 KB + 截断提示”，都没排除终端产物。正确规则在 `design.md:124`（worktree 截断提示；终端 >512 KB 不读取）和 `:383`（8.2）。
  - 影响：只读 3.1/FB-U6 的实现者可能为终端文本 >512 KB 再实现一个不可达的截断提示，重蹈 review-03 M1。
  - 修复：在两处加“仅 worktree 文本；终端产物 >512 KB 走 too-large / Copy path”。

- **[MINOR][FB-U3/R4 的 header Save 仍未写 dirty 条件] `tasks.md:30` 与 `test-plan.md:119` 仍把 header Save 描述为终端产物页的常驻能力。**
  - 证据：`tasks.md:30` FB-U3 写“终端产物页保留 Save”；`test-plan.md:119` R4 写“不变；预览页 Save 与溢出菜单并存”。设计 `design.md:387`（8.2）与 B23（`test-plan.md:79`）要求只有“可编辑文本 + 未保存修改”才渲染；现有代码 `mobile/src/files/MobileFilePreviewScreen.tsx:250-259` 对 clean 的可编辑文本仍渲染禁用 Save（`canSaveArtifact` 在 `:187-197` 才要求有草稿）。
  - 影响：按 FB-U3/R4 可实现出“clean 时保留禁用 Save”的旧行为，与 8.2/原型/B23 冲突；虽然 B23 能发现，但会造成 G4 返工。
  - 修复：FB-U3 改为“仅 dirty 可编辑文本渲染 Save；clean/图片/只读/超预算不渲染”；R4 改为“dirty 可编辑文本 Save 与溢出菜单并存；clean/图片/只读/超预算无 header Save”。

---

## 4. 上一轮及更早 blocker/major 回归核对

| 来源 | 结论 | 本轮证据 |
|---|---|---|
| Review-01 BLOCKER 2（Android SAF / ACTION_VIEW） | **未回归** | `design.md:272-279`（7.1 #1/#2）；`tasks.md:16-17` FB-T5/T6；`test-plan.md:57-69` B1-B13、`:85-86` C1-C2。 |
| Review-01/02 MAJOR（二进制行、终端 target、OTA、Markdown、读失败、HTML Frame、搜索上限/过滤、缓存、16 MB） | **未回归** | `design.md:281-285`（7.1 #3）、`:287-292`（#4）、`:294-298`（#5/#6）、`:303-314`（#8/#10/#11）、`:408-412`（8.6）、`:421-433`（8.8/8.9）、`:392-400`（8.3/8.4）、`:414-419`（8.7）；任务/测试对应项仍在。 |
| Review-03 M1（终端 >512 KB 截断不可达） | **未回归** | `design.md:136`、`:292`、`:383`；B10；07b。 |
| Review-03 M2（终端 header Save） | **未回归** | `design.md:387`；B23；Playwright 静态检查。 |
| Review-04 M1（3.3 截断残留） | **已解决** | 见 2.1。 |

---

## 5. 原型验证记录

Playwright（Chromium）加载 `file-actions.html` 做静态与交互检查：

- 静态：
  - header Save 只出现在 07 `file-artifact-text`（dirty，启用）；07b/08/08b 均无。
  - 07b 可见动作：Copy path、Cancel；08b 相同；无 Save/Open/Copy content。
  - 07 终端文本 sheet：Save to phone、Open with、Copy content、Copy path、Cancel（无 Preview）。
  - 08 终端图片 sheet：Save to phone、Open with、Copy path、Cancel（无 Preview）。
  - 03 文本顺序：Preview、Save to phone、Open with、Copy content、Copy path、Cancel。
  - 04 图片 / 05 媒体 / 06 PDF 动作与 7.2 矩阵一致，均无 Download。
  - 09 失败行菜单：Retry read、Copy path、Cancel。
  - 11 保存结果页：路径、SHA-256、24h 提示。
  - 16 结果头：“Showing first 32 of 148 matches”；结果副文案“Filters apply to these first 32 results only.”；16b 旧主机 5000 提示。
- 交互：
  - 01 点击 `.env` 进入失败预览 → 返回列表行显示 Read failed → 行尾 `…` 菜单为 Retry read / Copy path / Cancel（m10 保持修复）。
  - 16 的预览上下文会隐藏 Preview（`actionVisible` 的 `fromPreview` 分支），印证 3.1 的 MINOR。
- 未发现原型与 8.1/8.2 的 Save 单一入口、终端 header Save 状态、07b/08b 动作集合冲突。

---

## 6. Requirement coverage

| 用户需求 | 覆盖情况 | 结论 |
|---|---|---|
| 1. 长按选中复制文字 | 文本/代码/Markdown/HTML 选择语义、A5/A9/A11、原型 17 | **覆盖** |
| 2. 下载/保存到手机 | 唯一 Save to phone、prepare-only、24h、SAF ≤16 MB、>16 MB 分享回退、结果页 B21 | **覆盖** |
| 3. 用手机 App 打开 | ACTION_VIEW/contentUri/flags、iOS 分享/UTI/anchor、旧二进制降级、C1-C7 | **覆盖** |
| 4. 搜索/过滤 | 32/5000/20k、totalCount/truncated、懒加载过滤、D1-D14 | **覆盖**；A10 终端数组见 3.1 |
| 5. 不回归现有预览/媒体/终端编辑/OTA | R1-R12、B23、FB-U3 文案见 3.3 | **覆盖** |

---

## 7. 建议修改顺序

1. 修 A10 终端文本/图片数组（`test-plan.md:46`），并在 3.1/8.10 标注“预览页隐藏 Preview”。
2. 给 `design.md:89` 与 `tasks.md:33` 的“截断提示”加 worktree 限定。
3. 给 `tasks.md:30` FB-U3 与 `test-plan.md:119` R4 补 dirty/absent 条件。
4. 将 `tasks.md:3` 更新为 review-05 APPROVED_WITH_MINORS，并记录以上 3 个 MINOR 的处理决定（G3 出口要求）。

以上 3 项均为文档/测试文案修改，不改变架构或原型决策；修完即可进入 G4，无需再开设计评审轮次。若主会话选择保留当前文案，也应在 `tasks.md` 记录“接受 MINOR”的决定。

---

## 8. 待确认问题

无阻塞项。
