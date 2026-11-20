# 移动端文件浏览：选中复制、下载/打开、搜索过滤

> 日期：2026-11-10
> 范围：Orca Mobile 文件浏览器（`mobile/src/files`）与文件预览
> 目标：长按可选中复制文字；文件可下载到手机或用手机 App 打开；支持文件搜索与过滤。

---

## 1. 现状

### 1.1 文件浏览器

- 路由：
  - `mobile/app/h/[hostId]/files/[worktreeId].tsx` → `MobileFileExplorerScreen`
  - `mobile/app/h/[hostId]/files/preview/[worktreeId].tsx` → `MobileFilePreviewRoute`
- OTA 构建可能用桌面 web bundle 渲染文件页：`mobile/src/mobile-web-shell/shell-switch-decision.ts:15-19`。
- 主组件：`mobile/src/files/MobileFileExplorerPanel.tsx`
  - `files.readDir` → `fileDirectoryRead`；旧桌面回退 `files.list`。
  - 懒加载目录、缓存目录、FlatList 树。
  - 头部只有返回/关闭、标题、worktree 名；**没有搜索、过滤、排序或溢出菜单**。
- 行组件：`mobile/src/files/mobile-file-explorer-row.tsx`
  - 只有 `onPress`；目录展开、文件进预览。
  - 无 `onLongPress`、无上下文菜单。
  - 二进制行 disabled，显示 “Unavailable on mobile”。

### 1.2 预览类型

| 类型               | 渲染                                                 | 说明                                                                             |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| 文本/代码          | `MobileFilePreviewSourceText` 的 `<Text selectable>` | 支持原生长按选择；512 KB 上限，可能截断                                          |
| Markdown           | `MobileFileMarkdownPreview`，预览/源码切换           | 渲染段落默认不可选（`MobileMarkdown` 的 `rangeSelectable` 默认 false）           |
| 图片               | RN `<Image>`，data URI，可缩放                       | 10 MB 上限                                                                       |
| 音视频             | WebView 媒体文档                                     | `files.stat` + `files.readChunk`，384 KB/块，256 MB 上限；缓存文件预览结束即删除 |
| HTML（文件浏览器） | 源码文本                                             | 没有渲染预览                                                                     |
| HTML（会话产物）   | `MobileHtmlPreview`                                  | WebView/iframe，已有预览/源码切换                                                |
| PDF                | 不可预览                                             | 客户端排除；服务端其实能返回 base64                                              |
| 其它二进制         | 行禁用                                               | 无操作                                                                           |

### 1.3 已有能力与缺口

| 能力                 | 现状                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 长按复制文字         | 文本/代码预览已支持原生选择；Markdown 渲染段落默认不可选；无“复制全文/复制路径”菜单                                          |
| 下载保存到手机       | **不存在**。预览的 Save 只把终端产物写回桌面                                                                                 |
| 分享/用其它 App 打开 | **不存在**。没有 `expo-sharing`、Intent、FileProvider 流程                                                                   |
| 搜索/过滤            | **不存在** UI。服务端 `files.searchPaths` 已对移动端开放；已有 `use-mobile-native-chat-file-search.ts` 可复用其防抖/缓存思路 |
| 文件操作菜单         | 通用 `ActionSheetModal` 已存在，但文件 explorer/preview 未使用                                                               |

### 1.4 传输与限制

- 移动端只有 E2EE WebSocket RPC，没有 HTTP 下载 URL。
- 可用的分块读取：`files.stat` + `files.readChunk`（`FileReadChunk { worktree, relativePath, offset, length }`），移动端 allowlist 已包含。
- 文本预览：`files.read`，最大 512 KB。
- 图片预览：`files.readPreview`，本地最大 10 MB。
- 远程出站 JSON：4 MB；音视频分块下载上限 256 MB。
- 终端产物：只有整文件文本/图片读取，没有分块下载；需要新增能力或限制为小文件。

---

## 2. 目标与非目标

### 目标

1. 文件列表长按文件 → 操作菜单；预览页右上角 → 操作菜单。
2. 文本/代码/Markdown 预览可长按选中复制；提供“复制全文/复制路径”。
3. 文件可下载到手机（用户可见位置或系统“存储到文件/下载”）。
4. 文件可用手机其它 App 打开（系统分享/打开方式面板）。
5. 文件浏览器支持按文件名搜索，并按类型过滤；结果可继续预览/长按操作。
6. 不破坏现有目录懒加载、旧桌面回退、媒体预览、终端产物编辑。

### 非目标（本期）

- 文件内容全文搜索（`files.search` 未对移动端开放）。
- 离线文件缓存/同步。
- 桌面 web-shell 的完整下载桥接（见 6.2 决策）。

---

## 3. 方案

### 3.1 文件长按 / 预览菜单

新增 `MobileFileActionSheet`（基于 `ActionSheetModal`）：

- 动作按可用性动态生成，顺序固定：
  - **预览**（可预览文件）
  - **保存到手机**（Android SAF / iOS Save to Files；唯一用户可见的“下载”）
  - **用其它 App 打开**
  - **复制文件内容**（文本/HTML，≤512 KB；worktree 截断时提示；终端 >512 KB 为 too large）
  - **复制路径**
  - **取消**
- 触发点：
  - 行 `onLongPress`（`mobile-file-explorer-row.tsx` 的 `TreeRow` Pressable）。
  - 预览页右上角溢出按钮（由 FB-U3 提供；终端产物页仅“可编辑文本 + 未保存修改”时保留现有 Save，干净/图片/只读不渲染）。
- 目录长按：只显示“复制路径”；展开/折叠由点击行完成。
- 禁止用 `Download` 作为单独用户动作；cache 准备是 `Save to phone`/`Open with` 的内部阶段。
- 终端产物动作范围见 8.2；不再承诺 10 MB 图片。
- 读取失败行状态由用户动作后的失败缓存产生，不做逐行 stat（见 8.9）。

状态放在 `MobileFileExplorerPanel` / `MobileFilePreviewScreen`，用一个 `fileActionTarget` 对象：

```ts
type FileActionTarget = {
  worktreeId: string
  relativePath: string
  name: string
  kind: 'text' | 'image' | 'media' | 'binary' | 'directory'
  size?: number
  previewable: boolean
}
```

### 3.2 长按选中复制

- 文本/代码：保留 `MobileFilePreviewSourceText` 的 `<Text selectable>`；确认 iOS/Android 系统选择菜单可用。
- Markdown：
  - 不复用 `rangeSelectable`（它会把 Android 段落反向设为不可选）；新增独立 `nativeTextSelection`/`selectableText` prop，文件预览传入 true，聊天转录仍 false；
  - 源码模式保持 `<Text selectable>`；
  - 菜单提供“复制源码”作为兜底。
- HTML：
  - 本期提供“复制源码”；渲染视图文字选择由 HTML 需求的 `MobileHtmlPreviewFrame` 提供，FB-U11 在其后追加 `textInteractionEnabled` 与链接冲突处理（见 8.8）。
- 选择复制与“复制全文”区分：
  - 系统选择菜单复制选中的文字；
  - 操作菜单的“复制文件内容”按需读取（`files.read`/`readTerminalArtifact`，≤512 KB）；worktree 截断时提示“已复制前 512 KB”。终端产物文本 >512 KB 不读取，提示桌面处理。
- 复制路径使用 `platform/clipboard.ts`（已有 `expo-clipboard` seam）。

### 3.3 下载到手机

#### 数据获取

- Worktree 文件：
  - `files.stat` 获取 size/mtime/isDirectory。
  - `files.readChunk` 分块（384 KB，参考 `mobile-file-media-download.ts`）；校验每块字节数、最终 size/mtime，防止文件变化。
  - 图片/小文件可直接 `files.readPreview`/`files.read`（≤10 MB / 512 KB）以减少往返。
- 终端产物：
  - 文本：`files.readTerminalArtifact`，≤512 KB；>512 KB 现有 RPC 返回 `file_too_large`，提示 “Too large for mobile; open on desktop”，仅保留 Copy path。
  - 图片：按移动端出站预算约 3 MB（不是 10 MB）；超限提示“Too large for mobile; open on desktop”。
  - grant 过期用 `mobile-terminal-artifact-grant-refresh.ts` 刷新；补测试。

#### 写入与保存

- 统一先写入 app cache（`expo-file-system` 的 `Paths.cache`），文件名做安全化（去除 `/`、`..`、控制字符）。
- **保存到手机**（唯一用户可见动作）：
  - iOS：系统分享/存储面板（`expo-sharing` → “Save to Files”）。
  - Android ≤16 MB：`StorageAccessFramework.requestDirectoryPermissionsAsync()` + `createFileAsync()` + base64 写入（避免超大 JS 字符串）。
  - Android >16 MB：用分享面板/FileProvider 将 cache 文件交给“Files/Downloads/云盘”保存（不构造巨大字符串）；分享不可用则提示桌面处理。
  - Android SAF 仅用于小文件；大文件不走 SAF 直写。
- 准备过程：
  - 进度（已下载/总大小）、取消、失败重试。
  - 取消时删除临时文件。
  - 分享/ACTION_VIEW/SAF 完成后至少保留 24h（见 8.3）。
- 新增依赖：`expo-sharing` 与 `expo-intent-launcher` 首期都加入，需要 prebuild/dev client/商店重建；旧二进制必须能力探测降级（见 8.5）。

#### 平台与安全

- 文件名、MIME 类型由扩展名映射；未知类型 `application/octet-stream`。
- 不允许把任意远端路径写到用户指定路径；只能写 cache/用户通过系统 UI 选择的位置。
- 远程 SSH/WSL 主机同样走 RPC 分块读取，不假设本地文件系统。
- 大小上限：沿用 256 MB；超过提示“文件过大，请在桌面端处理”。
- 下载与预览互斥：同一文件下载中禁用重复下载按钮。

### 3.4 用手机 App 打开

- 使用 `expo-sharing` 的 `shareAsync(uri, { mimeType, dialogTitle })`：
  - iOS 弹出系统分享/打开方式面板；
  - Android 弹出系统 chooser，可交给其它 App。
- 若 `Sharing.isAvailableAsync()` 为 false 或无可用应用，提示并提供“下载到手机”。
- 分享前确保文件已完整写入 cache，且 URI 可被其它 App 读取。
- HTML/PDF 等类型优先走系统打开方式；文本/代码默认分享为 `.txt`/原扩展名。

### 3.5 搜索与过滤

#### 搜索

- 头部增加常驻搜索框。
- 使用 `files.searchPaths`：
  - 120 ms 防抖（复用 `use-mobile-native-chat-file-search.ts` 的模式）；
  - limit 固定 ≤32；
  - 旧主机 `method_not_found`/`forbidden` 时用 `isMobileMethodUnavailableError` 判定，回退到文件清单搜索；清单上限 5000，必须读取 `totalCount`/`truncated` 并提示，不称“全量”。
- 结果：
  - 扁平列表，显示相对路径 + 文件名；
  - 点击 → 预览；长按 → 操作菜单；
  - 清空搜索恢复树。
- 无结果/加载/错误状态。

#### 过滤

- 搜索框下方/头部放过滤 chips：
  - `全部` / `代码` / `文档` / `图片` / `其它`
  - 类型按扩展名映射（复用 `file-tree.ts` 的扩展名表，新增 `code`/`docs` 分类）。
- 过滤同时作用于树和搜索结果；过滤只影响展示，不改变服务器排序。
- 可选：“只看可预览”开关（默认关）。

#### 排序

- 本期保持服务端/现有排序（目录优先 + 自然序）；不加排序菜单，避免与服务端排序冲突。
- 如后续需要，增加“名称/类型/修改时间”并明确只对已加载目录生效。

### 3.6 OTA / web-shell 模式决策

当前 OTA 构建可能把文件页交给桌面 web bundle 渲染。本轮功能只在原生文件浏览器实现，因此：

- **推荐**：从移动端入口进入文件浏览器/预览时强制使用原生页面（`shellSwitchDecision` 对该路由返回 native），保证新功能可用且行为一致。
- 备选：为 web-shell 增加下载桥接和长按菜单，成本高、跨端一致性差。
- 该决策需要在设计评审中确认；若选择强制 native，需要检查 OTA 回退路径是否仍能访问桌面文件页的其它能力。

---

## 4. 组件与状态

```text
MobileFileExplorerPanel
  ├─ MobileFileSearchBar        (new)
  ├─ MobileFileFilterChips      (new)
  ├─ FlatList / MobileFileExplorerRow
  │    └─ onLongPress → MobileFileActionSheet
  └─ MobileFileDownloadProgress (new, or inline banner)

MobileFilePreviewScreen
  ├─ header: back / title / overflow menu (new) / Save (existing)
  ├─ MobileFilePreviewBody
  └─ MobileFileActionSheet
```

- 新组件：
  - `MobileFileActionSheet.tsx`
  - `MobileFileSearchBar.tsx`
  - `MobileFileFilterChips.tsx`
  - `MobileFileDownloadProgress.tsx`（或 hook 内联）
- 新 hook：
  - `use-mobile-file-actions.ts`（下载/分享/复制/路径）
  - `use-mobile-file-search.ts`（防抖、结果、回退）
- 复用：
  - `ActionSheetModal`、`BottomDrawer`、`platform/clipboard.ts`、`mobile-file-media-download.ts` 的分块模式、`use-mobile-native-chat-file-search.ts` 的防抖模式。

---

## 5. 边界与风险

| 风险                               | 处理                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| 512 KB 文本截断                    | 复制/下载时提示；下载走 chunk 取完整文件                             |
| 大文件/弱网                        | 进度、取消、重试；cache 256 MB 上限；SAF 直写 ≤16 MB，更大走分享面板 |
| 文件变化                           | 下载前后校验 size/mtime；变化则报错重试                              |
| 终端产物无分块                     | 文本 ≤512 KB；图片按 ~3 MB 预算；超限提示桌面处理                    |
| OTA web-shell 缺少原生能力         | 强制 native 路由；旧二进制能力探测降级（8.5）                        |
| iOS 文件打开方式                   | `expo-sharing` 系统面板；无法保证所有类型都有 App                    |
| Android FileProvider               | `expo-sharing` 处理 content URI；`ACTION_VIEW` 用 contentUri + grant |
| 路径/文件名注入                    | 服务端校验路径；客户端文件名安全化                                   |
| Markdown 渲染选择                  | 独立 `nativeTextSelection`，不复用 `rangeSelectable`                 |
| 旧服务器不支持 `files.searchPaths` | 清单回退，5000 上限提示；`method_not_found`/`forbidden` 都覆盖       |

---

## 6. 验收标准

1. 长按文本/代码/Markdown 文字可选中并复制；复制内容与显示一致。
2. 文件行/预览页菜单包含复制内容、复制路径、保存到手机、用其它 App 打开（按可用性显示）。
3. 小文件、大文件（分块）、图片、媒体、PDF/二进制（保存/打开）都有明确结果与错误提示。
4. 保存有进度、可取消；保存后可在系统文件管理器找到且哈希一致。
5. 搜索能按文件名找到未展开目录中的文件；过滤 chips 生效；旧服务器有回退提示。
6. 现有预览、媒体播放、终端产物编辑、目录懒加载不回归。

---

## 7. 评审 01 修订与决策（2026-11-10）

> 本节吸收 `reviews/design-review-01.md`；与上文冲突时以本节为准。

### 7.1 已确认决策

1. **Android 保存到手机（BLOCKER）**
   - 正式路径：`expo-file-system` 的 `StorageAccessFramework.requestDirectoryPermissionsAsync()` + `createFileAsync()`，由用户选择目录（Downloads/Files/云盘）后写入。
   - 分享面板不再作为“保存”的唯一实现；下载与分享拆成两个动作。
   - 重名策略：默认追加 ` (1)`；权限撤销/写入失败/取消均有明确提示。
   - 真机验收必须验证保存后的文件可被系统文件管理器打开，且内容哈希一致。
2. **Android 用其它 App 打开（BLOCKER）**
   - 首期加入 `expo-intent-launcher`；用 `expo-file-system` 的 `File.contentUri`（Expo 55 Android）生成 content URI，`ACTION_VIEW` + MIME + `FLAG_GRANT_READ_URI_PERMISSION`。
   - 无可用 Activity 时回退到分享面板，并提示“未找到可打开的应用”。
   - iOS 使用系统分享面板，补齐 UTI 与 iPad `anchor`。
3. **二进制行可操作**
   - 拆分 `previewDisabled` 与 `rowDisabled`：PDF/zip 等行保持可长按/可聚焦，只隐藏“预览”；仅当既不可预览也无任何动作时才禁用。
   - 更新 `accessibilityLabel/State` 与回归测试。
4. **FileActionTarget 改为来源联合类型**
   ```ts
   type FileActionTarget =
     | { source: 'worktree'; worktreeId: string; relativePath: string; name: string; kind: ...; size?: number; previewable: boolean }
     | { source: 'terminalArtifact'; worktreeId: string; absolutePath: string; grantId: string;
         pathText?: string; cwd?: string; terminalHandle?: string; nativeChatContext?: unknown;
         displayPath: string; name: string; kind: 'text'|'image'; size?: number; readOnly?: boolean }
   ```
   - 终端产物：文本 ≤512 KB；>512 KB 直接提示 “Too large for mobile; open on desktop”，仅保留 Copy path（现有 RPC 不支持截断读取）；图片按移动端 ~3 MB 出站预算，超限同样提示；补 grant 过期刷新与 Copy path = `pathText ?? displayPath`。
5. **OTA / web-shell**
   - 本版本文件浏览与预览路由**强制 native**，保证新能力可用；记录会失去的桌面 web 文件页能力。
   - 旧二进制（无新原生模块）不显示下载/打开动作，保留复制路径，避免崩溃。
6. **HTML 渲染视图文字选择**
   - 纳入本期范围，但落点是 HTML 需求抽出的 `MobileHtmlPreviewFrame`（HT-U6），不是旧的 `MobileHtmlPreview`。FB-U11 依赖 HT-U6/HT-V1，在 Frame 上追加 `textInteractionEnabled` 与链接冲突处理；禁止并行修改 Frame。补选区原型与 CJK/emoji 复制用例。
7. **搜索**
   - `files.searchPaths` 的 `limit` 固定 **≤32**（contract `.max(32)`）。
   - 新 search reader 读取 `totalCount`/`truncated`；结果头显示“共 N 个匹配 / 仅显示前 32 个”或“文件库超过 2 万，结果可能不完整”。
   - 本期不做分页；过滤在结果集内进行时必须显示“受上限限制”提示，不能暗示已过滤全部。
   - 旧主机回退复用 `files.list` 清单（上限 5000）；reader 必须保留 `totalCount`/`truncated`，结果头显示“Showing first 5000; results may be incomplete”，不称全量。
8. **过滤**
   - 保留匹配文件的祖先目录，隐藏空目录；不能用“逐行隐藏”导致树层级断裂。
   - 分类表：代码（ts/tsx/js/jsx/py/go/rs/java/c/cpp/h/css/scss/html/sh/json/yaml/toml）、文档（md/mdx/txt/pdf/doc/docx）、图片（png/jpg/jpeg/gif/webp/svg/bmp/ico）、媒体（mp3/mp4/mov/webm/wav/m4a）、其它。
   - 结果匹配完整相对路径与 basename（服务端行为）；UI 高亮匹配片段。
9. **UI 语言**
   - 实现沿用现有移动端英文文案；原型中文仅用于设计沟通，不作为最终文案。
10. **iOS 覆盖**
    - iOS 模拟器为本需求 G6 必过项（分享/存储到文件），不得标记“未覆盖”。
11. **缓存生命周期**
    - 每次下载使用独立子目录 + 唯一文件名；分享/ACTION_VIEW/SAF 完成后至少保留 24 小时；24 小时后可清理。
    - 缓存上限 512 MB，LRU 清理；设置页提供“清除下载缓存”；应用启动清理孤儿目录。
12. **重试**
    - 本期不支持断点续传；失败/取消后删除临时文件，重试从头开始。
    - 下载前后校验 `size/mtime/ctime`；文件变化时报错。
13. **文件名/MIME**
    - `safeLocalFileName()` 处理 `/`、`..`、控制字符、Unicode 双向控制符、超长名（≤255 字节）、点文件、无扩展名、0 字节。
    - 统一 MIME/UTI 映射；代码/纯文本回退 `text/plain`；未知类型 `application/octet-stream` 并提示可能无应用可打开。
    - 至少覆盖：
      | 扩展名             | MIME                            | iOS UTI              |
      | ------------------ | ------------------------------- | -------------------- |
      | png                | image/png                       | public.png           |
      | jpg/jpeg           | image/jpeg                      | public.jpeg          |
      | gif                | image/gif                       | com.compuserve.gif   |
      | webp               | image/webp                      | org.webmproject.webp |
      | pdf                | application/pdf                 | com.adobe.pdf        |
      | zip                | application/zip                 | public.zip-archive   |
      | mp4                | video/mp4                       | public.mpeg-4        |
      | mp3                | audio/mpeg                      | public.mp3           |
      | md/txt/ts/tsx/html | text/plain（html 可 text/html） | public.plain-text    |
      | 未知               | application/octet-stream        | public.data          |
14. **可发现性/无障碍**
    - 长按触发 `triggerMediumImpact` 触觉；文件行保留轻量“…”入口作为长按的替代（满足无障碍/可发现性）。
    - 所有触控目标 ≥44×44 或使用 hitSlop；打开/关闭弹层保持焦点管理。

### 7.2 文件类型 × 动作矩阵

| 类型             | 预览                                 | 复制内容       | 保存到手机    | 打开方式      |
| ---------------- | ------------------------------------ | -------------- | ------------- | ------------- |
| 文本/代码        | ✅                                   | ✅（截断提示） | ✅            | ✅            |
| Markdown         | ✅（渲染/源码）                      | ✅             | ✅            | ✅            |
| 图片             | ✅                                   | —              | ✅            | ✅            |
| 音视频           | ✅                                   | —              | ✅            | ✅            |
| HTML             | ✅（源码；渲染见 HTML 需求）         | ✅             | ✅            | ✅            |
| PDF              | ❌（本期不做 PDF 预览）              | —              | ✅            | ✅            |
| 其它二进制       | ❌                                   | —              | ✅            | ✅            |
| 目录             | —                                    | —              | —             | —             |
| 终端产物（文本） | ✅（≤512 KB）                        | ✅（≤512 KB）  | ✅（≤512 KB） | ✅（≤512 KB） |
| 终端产物（图片） | ✅                                   | —              | ✅（≤~3 MB）  | ✅（≤~3 MB）  |
| 读取失败/无权限  | 行徽标 + Retry（由动作失败缓存产生） | —              | —             | —             |

### 7.3 进度与状态机

- 统一 `prepareFileForAction(target)`：stat（如需要）→ 分块写入 cache → 校验 → ready；prepare 不是用户可见的 Download。
- 单飞：同一 target 只允许一个准备任务；文件页与预览页共享进度/取消/重试 UI。
- 状态：`idle → preparing(progress) → ready → saving/sharing → done | error`。
- 分享/ACTION_VIEW/SAF 后至少 24h 保留；目标 App 异步读取期间不得删除。

### 7.4 风险与回滚

- 下载/分享/打开方式通过远端开关或本地 feature flag 控制；异常时可回退为“复制路径/复制内容”。
- `expo-sharing`/`expo-intent-launcher`/SAF 需要重建原生二进制；旧二进制必须安全降级。
- 大文件/弱网/后台被杀/目标 App 延迟读取均需设备用例。

---

## 8. 评审 02 修订与决策（2026-11-10）

> 本节吸收 `reviews/design-review-02.md`；与上文冲突时以本节为准。

### 8.1 “下载/保存”只保留一个用户动作

- 删除用户菜单里的 `Download`。`Save to phone` 是唯一的“下载到手机”动作：
  - Android：SAF 目录选择 → 写入；iOS：分享面板 → Save to Files。
  - “prepare cache”只是 Save/Open 内部阶段，进度文案为 “Preparing file…” 或 “Saving to phone…”，不出现用户可见的 Download 语义。
- “打开方式”与“保存”共享 prepare，但动作入口分开；保存成功后 toast 文案固定为 “Saved to phone”，随后显示保存结果页（路径、SHA-256、“Cached copy kept for 24 hours”；同一 ActionSheet 流程，不新增导航）。
- 测试：仅点 Save 后文件出现在用户选择的位置；只 prepare 不产生用户可见文件。

### 8.2 终端产物范围与目标模型

- `FileActionTarget` 按 7.1 #4 补齐 `worktreeId/pathText/cwd/terminalHandle/nativeChatContext/readOnly`。
- 文本：`files.readTerminalArtifact`，≤512 KB；>512 KB 现有 RPC 直接 `file_too_large`，不承诺截断读取；显示 “Too large for mobile; open on desktop”，仅保留 Copy path。
- 图片：按移动端出站 JSON 预算 ~3 MB 判定；超限只允许 Copy path + “Too large for mobile; open on desktop”。
- Copy path = `pathText ?? displayPath`，grant 刷新后仍复制用户看到的路径。
- 新增 `prepareTerminalArtifact`：文本读入/图片 base64 写入 cache；grant 过期先刷新再重试一次。
- 终端产物预览页的 header Save **只**用于“可编辑文本 + 有未保存修改”的现有写回；图片、只读、超预算状态不渲染 Save。sheet 的 Save to phone 是唯一的保存到手机动作。FB-R4 断言可编辑文本 Save 不回归。

### 8.3 缓存保留

- 每次 prepare 独立目录 + 唯一文件名。
- 分享/ACTION_VIEW/SAF 完成后至少保留 **24 小时**；24h 后允许清理；512 MB LRU；启动清理孤儿；设置页“Clear download cache”。
- 测试：面板关闭 5 分钟后仍可读；24h/清理后不存在；填满 512MB 后最旧项被淘汰、最新项保留；15.9/16/16.1MB 分别走 SAF/分享分支。

### 8.4 搜索与过滤边界

- 新主机：`files.searchPaths` limit ≤32，读取 `totalCount/truncated`，显示 “Showing first 32 of N matches”。
- 旧主机：`files.list` 清单上限 5000；在 `legacyFileListSchema`/`mobile-file-explorer-operations.ts` 保留 `totalCount` 与 `truncated`，显示 “Showing first 5000; results may be incomplete”，不称全量。`method_not_found` 与 `forbidden` 都用 `isMobileMethodUnavailableError` 判定。
- 懒加载树过滤：未加载目录一律保留并显示 “not loaded” 提示；只隐藏“已加载且无匹配后代”的目录；补三种变体测试。
- 分类：All/Code/Docs/Media/Images/Other；PDF 归 Docs（与原型一致）。

### 8.5 旧二进制 / OTA 能力探测

- 新增 `file-action-capabilities.ts`：用 `requireOptionalNativeModule`/动态 import 探测 `ExpoSharing`、`ExpoIntentLauncher`、SAF；缺少时**不静态崩溃**。
- 旧二进制（OTA JS + 旧 native）：隐藏 Save/Open，保留 Copy path/Copy content，并显示 “Update Orca on this device to use file actions”。
- 测试：mock 缺失模块 → 动作集合正确、不崩溃；旧二进制真机/模拟用例；FB-R6 断言 native 路由 + 动作集合，而不是“可用或提示”。

### 8.6 Markdown 原生选择

- 不复用 `rangeSelectable`（Android 会经 `androidTranscript` 把段落设为不可选）。
- `MobileMarkdown` 增加显式 `textSelectionMode: 'chat-transcript' | 'document'`（或等价 `nativeTextSelection`）：document 下段落/标题/列表/代码 `selectable=true`；chat-transcript 保持现有行为。
- 单测：Android document 模式可选；聊天转录仍不可选；设备 A5 覆盖 CJK/emoji/折行。

### 8.7 SAF 大文件

- SAF 直写只用于 ≤16 MB（避免 base64 大字符串 OOM/ANR）。
- > 16 MB 至 256 MB：用 `expo-sharing` 分享 cache 文件，让用户在 Files/Downloads/云盘保存（FileProvider 流式读取），不构造大字符串。
- > 256 MB：提示 “File is too large; save it on desktop.”
- 测试：10 KB SAF、18.2 MB 分享保存、重名/扩展名/哈希；接近 256 MB 的失败提示。

### 8.8 与 HTML 需求的交付顺序

- FB 核心（菜单/预览/搜索）→ HTML Frame（HT-U6/HT-V1）→ FB-U11 文字选择。
- FB-U11 依赖 HT-U6/HT-V1；不得直接改旧 `MobileHtmlPreview`；交叉 builder/菜单测试由 HTML 的 HT-Q7 覆盖（FB-Q7 只做无障碍/触控/长按互斥）。
- FB 动作矩阵不包含 Orca 浏览器。

### 8.9 读取失败行

- 不在 `readDir` 逐行 stat。面板维护 `readFailures: Map<relativePath, {code,message}>`，只在该行预览/操作读取失败后写入。
- 行显示 “Read failed” 徽标；长按菜单提供 Retry（重新预览/读取），成功后清除。
- 重连只清除断线/超时类失败；EACCES/EPERM/ENOENT 只在 Retry 成功后清除。
- 错误码映射：EACCES/EPERM、ENOENT、断线/超时、其它；补 stat/read 403 → 徽标 → Retry 成功用例。
- 跨屏：`readFailures` 放模块级 registry/context（面板与预览路由共享），预览失败返回列表后行徽标可见；补组件用例。

### 8.10 用户流程

1. 列表长按/行尾 `…`：出现 sheet（Preview/Save/Open/Copy/Cancel）；长按后释放不触发预览。
2. 预览页 `…`：同一 sheet；终端产物同时保留 Save。
3. 搜索：输入 → loading → 结果（最多 32）→ 点行预览/长按操作；清空恢复树。
4. 保存：选 Save → prepare 进度 → Android SAF 目录选择/iOS 分享保存 → 成功 toast；取消 → 清理临时文件。
5. 打开：prepare → Android ACTION_VIEW chooser/iOS share → 取消回预览；失败提示。
6. 失败：读取/权限/离线/超预算 → 行或 sheet 提示，可 Retry；不静默。

### 8.11 备选方案与取舍

- 不用 HTTP 下载 URL：移动端只有 E2EE RPC，无桌面中转；分块读取复用现有契约。
- 不用“仅分享面板”作为 Android 保存：SAF 才能保证用户可见目录与可预期文件名；大文件再回退分享。
- 不做分页搜索：先限 32 + 明确 truncated，避免移动端长列表与契约改动。
- 不逐行 stat：避免大目录 RPC 风暴；失败状态按需产生。
- 不并行改 HTML Frame：先抽受控组件，再追加选择，避免两套 mode 源。

### 8.12 测试与原型修订

- 测试直接改现有表：删除 D3“已加载目录过滤”与 D11 冲突；D5 补 Media 六类；A1 补 Save to phone；A2 目录仅 Copy path；B6 改为从头重试；删除 iOS 例外；FB-R6 改为能力/路由断言。
- 新增用例：读失败徽标/Retry（含预览失败→返回列表→徽标）、旧二进制缺模块（含 SAF/contentUri）、grant 过期、32 条过滤提示、5000 清单提示、搜索 loading/离线、长按/点击互斥、列表侧进度/单飞、SAF 大文件、16MB 边界、LRU、终端图片超预算、终端文本 >512KB 提示、Copy path `pathText ?? displayPath`。
- 原型：删除 Download；改 Save to phone；搜索结果行接预览/长按 sheet；终端 header Save 只保留“可编辑文本+未保存修改”；删除 07b 截断态，改为 07b “too large”；图片/超预算不显示 header Save；iOS 副文案与 Android 区分；PDF 归 Docs；目录菜单只 Copy path；补列表侧进度、失败 Retry、保存结果页。
- 所有断言写具体动作数组、文案、文件可见性与哈希。

### 8.13 发布/构建

- 新增 `expo-sharing`、`expo-intent-launcher` 后必须 prebuild/dev client 重建，并更新应用版本号。
- 发布验证：新二进制动作可用；旧二进制 OTA 不崩溃且能力降级；商店构建包含原生模块。
- 回滚：feature flag 关闭 Save/Open，保留 Copy path/content/搜索。
