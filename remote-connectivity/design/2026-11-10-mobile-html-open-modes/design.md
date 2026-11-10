# 移动端 HTML 文件：代码/渲染切换与打开方式菜单

> 日期：2026-11-10
> 范围：Orca Mobile 文件浏览器中的 HTML 预览（`mobile/src/files`）
> 目标：HTML 文件可切换源码/渲染页面；提供右侧菜单、长按菜单，并在有多种打开方式时自动弹出选择。

---

## 1. 现状

### 1.1 文件浏览器中的 HTML

- 路由：`mobile/app/h/[hostId]/files/preview/[worktreeId].tsx` → `MobileFilePreviewScreen`。
- `MobileFilePreviewBody.tsx:102-114` 对 HTML 只渲染 **源码文本**（`MobileFilePreviewSourceText`），没有渲染分支。
- `mobile/src/session/mobile-artifact-kind.ts:1-4` 的注释说 HTML 在沙箱 WebView 中渲染，但那是 **会话文件页**，不是文件浏览器预览。
- 预览页头部只有返回和可选的 Save（终端产物），没有模式切换/溢出菜单。

### 1.2 已有的 HTML 渲染能力

- `mobile/src/components/MobileHtmlPreview.tsx:18-74`
  - 预览/源码两个 tab（`:25-51`）。
  - 原生 `WebView`，JS 开启（`:52-71`）。
  - 导航锁：`about:blank`/`data:` 原地加载，其它 URL 走 `openExternalLink`（`:61-67`）。
- `MobileHtmlPreview.web.tsx`：沙箱 iframe `srcdoc`（`:71-119`，sandbox 常量 `:32`）。
- 仅被会话文件 tab 使用：`MobileSessionFileReader.tsx:305-311`。

### 1.3 现有模式/菜单

- 移动端没有统一的预览模式注册表；按扩展名分散判断：
  - `classifyMobileArtifact` → `image | html | other`
  - `textKindForPreviewPath` → `html | markdown | text`
- `MobileFileMarkdownPreview.tsx:27-84` 已有紧凑的“预览/源码”双按钮工具栏，可直接借鉴。
- 移动端文件行没有长按菜单；预览页没有溢出菜单。
- 复用组件：`ActionSheetModal`、`PickerModal`、`BottomDrawer`。
- 路由参数 `MobileFilePreviewRouteParams` 没有 `mode`；导航只有一个入口 `navigateToMobileFilePreview`。
- 桌面已有类似能力但不是同一形态：
  - `HtmlDocPreview` + `DocPreviewToolbar`：`Open source file`（打开新 editor tab）、`Open with default app`、溢出菜单。
  - 桌面文件树右键菜单有 `View File`、`Open in Orca Browser`、`Open Markdown Preview`、`Download`，但没有 HTML 专用“预览/源码”切换。

---

## 2. 目标与非目标

### 目标

1. 文件浏览器预览 HTML 时，可在 **渲染页面 / 源码** 之间切换。
2. 预览页右侧提供 **更多打开方式** 菜单（模式 + 外部打开 + 复制路径等）。
3. 长按 HTML 文件行弹出同一套打开方式菜单。
4. 当存在多种可用打开方式且用户未记住偏好时，点击文件 **自动弹出选择**。
5. 记住选择（按文件类型），可在 Browser 设置页恢复“每次询问”。
6. 渲染视图沿用现有安全模型：JS 开启 + 导航锁；Web 端使用沙箱 iframe。

### 非目标

- 桌面端 HTML 预览的同形态 in-preview 切换（桌面现有“打开源码文件”/“默认应用打开”保留；可作为后续对齐项）。
- 完整支持带相对资源（CSS/JS/图片）的 HTML 站点预览；见 3.4。
- PDF/其它二进制预览。

---

## 3. 方案

### 3.1 打开方式模型

```ts
type MobileHtmlOpenMode =
  | 'ask'        // 每次询问（默认）
  | 'preview'    // 渲染页面
  | 'source'     // 源码
```

可用动作（按能力动态生成）：

| 动作 | 条件 | 行为 |
|---|---|---|
| 预览页面 | 文件可读、HTML、未截断 | 渲染视图 |
| 查看源码 | 文件可读 | 源码视图（截断时提示） |
| 保存到手机 | 文件可下载且原生能力可用 | 复用文件浏览需求的保存能力 |
| 用其它 App 打开 | 文件可下载且原生能力可用 | 复用文件浏览需求的打开能力 |
| 复制内容 | 文本/HTML | 复制源码；>512 KB 复制前 512 KB 并提示 |
| 复制路径 | 总是 | 相对路径 |

- “在 Orca 浏览器打开”本期**不提供**（移动端缺少远程绝对路径/doc-preview grant）；见 7.3。
- “每次询问”恢复入口只在 Browser 设置页；菜单内不提供。

- 偏好键：`orca:mobileHtmlOpenMode`，默认 `ask`。
- Browser 设置页增加 “HTML open mode: Ask / Preview / Source”（行 + PickerModal，与现有设置一致）。

### 3.2 触发点

1. **点击文件行**
   - `MobileFileExplorerPanel.previewFile` 前置判断：
     - worktree HTML 且偏好为 `ask` → 弹出 `MobileFileOpenModeSheet`（固定 Preview/Source 两项）；
     - 偏好为 `preview/source` → 直接带 `mode` 进预览（随后按 8.4 优先级处理）；
     - line/column 深链与 terminal artifact → 直接 Source，不弹层。
   - 弹层含“记住我的选择”开关；选中后写偏好并打开。
2. **长按文件行**
   - 复用文件浏览需求的 `MobileFileActionSheet`，HTML 文件额外显示“预览页面/查看源码”；不显示 remember 开关。
3. **预览页右侧溢出菜单**
   - 头部右侧 `…`（由文件浏览 FB-U3 提供）：用其它 App 打开、保存到手机、复制内容、复制路径；HTML 用模式 Preview 取代通用 Preview，并追加 Source，不新增第二个入口。
4. **预览页第二行工具栏切换**
   - 渲染/源码两个 tab（或分段控件），与 `MobileHtmlPreview` 的 tab 形态一致；切换即时生效，不返回列表；header 不放切换控件。

### 3.3 路由与状态

- 扩展 `MobileFilePreviewRouteParams`：
  ```ts
  type MobileFilePreviewRouteParams = {
    // existing...
    mode?: 'preview' | 'source'
  }
  ```
- `navigateToMobileFilePreview` 增加 `mode` 参数；默认按偏好/文件类型决定。
- `MobileFilePreviewScreen` 读取 `mode`，用 page-local state 切换；不通过 `setParams`；返回不写偏好，再次进入按 8.4 重新决定。
- 预览内容仍由 `loadMobileFilePreview` 加载；渲染/源码共用同一份 `content`。

### 3.4 渲染视图

- 原生：复用 `MobileHtmlPreview` 的 WebView 逻辑（JS 开启、导航锁、外部链接走 `openExternalLink`）。
- Web：复用 `MobileHtmlPreview.web.tsx` 的沙箱 iframe。
- 相对资源限制：
  - `srcdoc`/`data:` 渲染无法解析工作区相对路径（CSS/JS/图片）。
  - 设计：检测到引用后，渲染视图顶部显示 “Relative assets may not load: … . Detected from src / href / url() in this file.”（最多 3 个引用）；不提供 Orca 浏览器入口。
  - 不直接在 WebView 中开放 `file://` 任意本地文件访问；避免路径穿越与安全风险。
- 大小：
  - `files.read` 上限 512 KB；源码可能截断。
  - 渲染视图优先使用已加载内容；`truncated` 时禁用 Preview（“File is larger than 512 KB. Rendering is unavailable; open the source or use desktop Orca.”），源码显示“Showing first 512 KB”。
  - 不接入 `files.readDocPreview`；完整渲染另立 host asset scheme/grant 设计。

### 3.5 安全

- 复用会话 HTML 预览的安全模型，导航策略按 8.1：
  - 原生 WebView JS 开启；顶层只允许 about/data 原地加载，外部链接走 scheme 白名单；子帧按 isTopFrame 放行/拒绝，不拉起外部 App。
  - Web 端 iframe `sandbox`（现有常量）。
- 不注入任意本地文件路径；不使用 `allowFileAccess`。
- 预览导航使用独立的白名单模块 `html-preview-scheme.ts`（http/https/mailto），**不修改** `openExternalLink` 的既有契约（其它入口依赖其直通行为）。
- HTML 内脚本无法通过 `window.ReactNativeWebView` 访问宿主桥（现有 WebView 未注入桥）；保持这一点。

### 3.6 桌面一致性

- 桌面保留现有：
  - `Open source file` → 新 editor tab；
  - `Open with default app`；
  - 文件树 `Open in Orca Browser`。
- 移动端新增 in-preview 切换是移动端体验增强；不强制桌面同形态。后续可在 `DocPreviewToolbar` 增加“源码/页面”分段控件，但本期不做。

---

## 4. 组件

```text
MobileFilePreviewScreen
  ├─ header: back / title / overflow menu（文件浏览 FB-U3；不在 header 放模式切换）
  ├─ second row: [预览 | 源码]
  ├─ MobileFilePreviewBody
  │    ├─ mode=preview → MobileHtmlPreview (reuse)
  │    └─ mode=source  → MobileFilePreviewSourceText
  └─ MobileFileOpenModeSheet (auto/choose, remember)
```

- 新组件：
  - `MobileFileOpenModeSheet.tsx`（基于 `PickerModal`/`ActionSheetModal`）
  - `mobile-file-open-mode-actions.ts`（纯函数，便于测试）
- 复用：
  - `MobileHtmlPreview.tsx` / `.web.tsx`
  - `MobileFilePreviewSourceText.tsx`
  - `MobileFileMarkdownPreview` 的紧凑切换工具栏样式
- 状态：
  - 偏好 `orca:mobileHtmlOpenMode`
  - 路由 `mode`
  - 弹层 `pendingHtmlOpen`

---

## 5. 边界与风险

| 风险 | 处理 |
|---|---|
| 相对 CSS/JS/图片不加载 | 检测后顶部提示，列出引用；不提供 Orca 浏览器入口 |
| >512 KB 源码截断 | 源码截断提示；Preview 禁用并提示桌面处理 |
| WebView 安全 | 沿用导航锁/沙箱；白名单只约束预览导航；不开放 file 访问 |
| 旧主机不支持浏览器能力 | 与本期无关（Orca 浏览器动作已移除） |
| 记住偏好的迁移 | 新增键默认 `ask`；不影响其它文件类型 |
| 自动弹层过于频繁 | 仅 worktree HTML 且偏好为 ask 时弹两个模式；提供“记住” |
| OTA/web-shell 路由 | 与文件浏览需求一致：原生路由或明确提示 |
| 会话 HTML 预览回归 | 复用组件时保持其现有 props/行为，单独回归 |

---

## 6. 验收标准

1. HTML 文件默认（首次）点击时弹出打开方式选择；选择“预览”或“源码”后进入对应视图。
2. 预览页可在渲染/源码之间即时切换，内容一致。
3. 预览页右侧菜单和长按文件菜单都能切换模式/打开方式。
4. “记住我的选择”生效；设置可恢复“每次询问”。
5. 渲染视图能显示自包含 HTML；相对资源缺失时有提示且不会崩溃。
6. 外部链接仅允许 http/https/mailto 离开展示页；其余 scheme 被拒绝，不在 WebView 内跳转。
7. 现有会话 HTML 预览、Markdown 切换、文件预览不回归。

---

## 7. 评审 01 修订与决策（2026-11-10）

> 本节吸收 `reviews/design-review-01.md`；与上文冲突时以本节为准。

### 7.1 菜单统一（BLOCKER）

- 文件浏览需求的 `MobileFileActionSheet`、`share-file.ts`、`open-file.ts` 是唯一实现；HTML 不新建菜单。
- 文件动作构造器扩展为：
  ```ts
  buildFileActions(target, { context: 'list'|'preview', htmlOpenMode?: 'preview'|'source', capabilities })
  ```
  HTML 用模式 Preview 取代通用 Preview，并追加 Source；不定义另一套保存/打开/复制文案。唯一顺序见 8.5。
- 预览页只保留一个右侧溢出入口；HTML 的“预览/源码”切换放在第二行工具栏（与 `MobileMarkdownPreview` 一致），不放在 header 再加一个控件。
- HTML 任务必须依赖 FB-T2、FB-U1、FB-U10；两个子代理按“文件浏览先合并、HTML 再扩展”的顺序开发，禁止并行修改同一菜单文件。
- 增加“文件浏览 + HTML 同时存在”的组件测试：动作无重复、顺序稳定、禁用规则一致。

### 7.2 受控预览组件

- 抽出 `MobileHtmlPreviewFrame`：
  ```ts
  { html, mode, onModeChange?, showToolbar?, onExternalLink }
  ```
  只负责 WebView/iframe、导航策略和安全；不持有 mode 状态。
- 会话文件页保留薄包装 `MobileHtmlPreview`，默认 `showToolbar`，保持现有 Preview/Source 行为。
- 文件浏览器预览由 `MobileFilePreviewScreen` 持有 mode（来自路由/本地 state），驱动 Frame；路由 `mode` 可生效。
- 组件测试：路由 `mode=source` 直接进入源码；切换不产生双控件；会话页回归不变。

### 7.3 “在 Orca 浏览器打开”本期降级

- 移动端缺失远程 worktree 的绝对路径/doc-preview grant，`browser.tabCreate` 只接受 URL；本期**不提供**“在 Orca 浏览器打开”HTML 文件，避免打开错误的本机文件。
- 打开方式菜单保留：预览页面、查看源码、保存到手机、用其它 App 打开、复制内容、复制路径、取消（顺序见 8.5）。
- 后续若需要，另立桌面 RPC（如 `files.openInBrowser`，复用 `getWorkspaceFilePreviewPlan`），并做 paired 兼容设计；不在本期任务内。
- 测试：不再断言 Orca 浏览器；原型移除该动作。

### 7.4 安全模型修正

- `openExternalLink` 当前只是 `Linking.openURL`，**没有** scheme 白名单；设计不再声称有限制。
- 新增 `isAllowedHtmlPreviewScheme(url)`：仅允许 `http:`、`https:`、`mailto:`；显式拒绝 `file:`、`intent:`、`javascript:`、自定义 deep link。
- `MobileHtmlPreviewFrame` 的导航策略（按平台可行性修正，见 8.1）：
  - 顶层 `about:blank`/`data:` 原地加载；
  - 允许 scheme 的外部 URL 交给宿主打开；
  - 拒绝其余 scheme；
  - 脚本/`meta refresh` 同样只能走 scheme 白名单；Android 不承诺区分手势，非白名单 scheme 一律拒绝。
- 记录限制：iframe 与页面内 `fetch`/图片仍可发起网络请求（与现有会话预览一致）；本期不引入 CSP，但在设计/测试中明确该边界；后续可加可选 CSP。
- 测试：恶意脚本自动跳转、`meta refresh`、iframe、`file:`/`intent:`/`javascript:`、web 端 iframe 行为。

### 7.5 相对资源提示

- 新增纯函数 `findRelativeHtmlAssetRefs(html)`：解析 `src`、`href`、`url(...)`，忽略 `data:`、`http(s):`、`#`、`/` 绝对路径；返回前几个相对引用。
- 只有检测到相对引用时才显示提示，文案列出实际资源名（最多 3 个）+ “相对资源可能无法加载”。
- 单测覆盖自包含 HTML（不提示）、相对 CSS/图片/JS（提示）、混合引用、空 HTML。
- 原型按“检测后提示”更新，不再固定列出资源。

### 7.6 >512 KB 行为

- `files.read` 返回 `truncated` 时：
  - 源码视图显示截断内容 + “仅显示前 512 KB”；
  - 渲染视图**禁用**，显示“文件超过 512 KB，暂不支持渲染；请在桌面端打开”；
  - 不再声称 `files.readDocPreview` 可解决；如需完整渲染，另立 host asset scheme/grant 设计。
- 测试：511 KB、512 KB、513 KB、1 MB；断言渲染禁用/提示/源码截断。

### 7.7 记住选择语义

- 只有自动弹层的 `preview`/`source` 动作显示“记住我的选择”；长按/溢出菜单不显示 remember，选择模式也不写偏好。
- 选择保存/打开/复制路径**不**写偏好、不关闭自动询问。
- 偏好键统一为 `orca:mobileHtmlOpenMode`；读取时校验枚举，非法/损坏回退 `ask`。
- 测试：记住预览、记住源码、外部动作不记忆、损坏偏好回退、设置恢复每次询问。

### 7.8 设置落点

- 放入现有 Browser 设置页（与 `terminalLinkOpenMode` 同页），增加 “HTML open mode: Ask / Preview / Source” 选择器。
- 具体文件：`mobile/src/settings/browser-settings-screen.tsx`、`storage/preferences.ts`；不新建 Files 设置页。
- 测试：从设置页切换后立即生效；失败写入回退并提示。

### 7.9 OTA / 参数链

- 与文件浏览需求一致：文件浏览/预览路由**强制 native**；OTA 构建不再渲染桌面 web 文件页。
- `mode` 必须进入：
  - `MobileFilePreviewRouteParams`；
  - `mobile/app/h/[hostId]/files/preview/[worktreeId].tsx` 与 `.web.tsx` 的参数解析；
  - route normalize 白名单；
  - shell params（若 shell 仍可达，至少不丢 mode）。
- 测试：OTA 下强制 native 或明确提示；mode 在深链/返回/重载中不丢失。

### 7.10 深链与终端产物优先级

- 路由带 `line`/`column` 时默认 `source`（与 Markdown `initialLine` 一致），确保滚动到目标行。
- `source=terminalArtifact` 的可编辑 HTML：本期**只读源码**，不提供渲染预览；保存仍走现有终端产物写回。
- 路由 normalize 对 `terminalArtifact` 分支也校验/透传 `mode`。
- 测试：line/column 默认 source；terminalArtifact HTML 无渲染 tab；保存行为不变。

### 7.11 自动弹层计数

- worktree HTML：自动弹层固定展示 Preview/Source 两项；`files.read` 后 `truncated` 时在页面内禁用 Preview，不在弹层前 stat。
- `line`/`column` 深链与 terminal artifact：直接 Source，不弹层；terminal artifact 不提供渲染。
- 长按/溢出菜单展示全部可用动作；自动弹层只负责模式选择。
- 测试：首次弹层、记住后直开、外部动作不改偏好、truncated 后 Preview 禁用、line/terminal 直开。

### 7.12 测试方案修正

按现有实现修正断言：

- 删除“无限循环有超时/限制”“非 UTF-8 报错”等不成立的断言；改为“可退出预览/不崩溃”。
- 新增：scheme 白名单/脚本自动跳转/meta refresh/iframe/web iframe、mode 路由归一化/OTA、设置恢复、偏好损坏、外部动作记忆、0 字节、CJK/emoji 内容与文件名、返回/旋转、断线重连、相对资源检测、512 KB 边界。
- native 与 web 的脚本行为分开写：native 执行，web sandbox 不执行。

### 7.13 UI 与文案

- 实现沿用移动端英文文案；原型中文仅作沟通示意，不作为实现依据。
- 溢出菜单改用 `ActionSheetModal`/`BottomDrawer`（移动端无 popover primitive），补 scrim/back/焦点管理。
- 触控目标 ≥44×44 或 hitSlop；分段控件/溢出按钮加 `accessibilityState`（selected/expanded）。
- 原型补齐：相对资源提示（检测后）、>512KB 禁用、读取失败、无可用 App、禁止的 scheme、长按菜单动作顺序。
- 长按 500ms、触觉反馈、滚动中取消长按、与行 `onPress` 互斥。
- 返回模式用局部 state，不通过 `setParams` 触发 OTA 重挂载；定义返回重置规则。

### 7.14 风险与回滚

| 风险 | 处理 |
|---|---|
| 与文件浏览菜单/预览页冲突 | 文件浏览先合并，HTML 仅追加；一个溢出入口；交叉测试 |
| 恶意 HTML 拉起外部 App | scheme 白名单 + 用户激活；显式拒绝 file/intent/javascript |
| 相对资源/大文件限制被误解 | 检测后提示 + 截断横幅 + 桌面端引导 |
| OTA 强制 native 影响桌面 web 文件页 | 发布说明/降级提示；评审确认 |
| 终端产物 HTML 编辑/预览冲突 | 本期只读源码；保存路径不变 |
| 偏好损坏/迁移 | 校验枚举回退 ask；单测 |

---

## 8. 评审 02 修订与决策（2026-11-10）

> 本节吸收 `reviews/design-review-02.md`；与上文冲突时以本节为准。

### 8.1 原生导航策略（Android 可行性）

- RN WebView 13.16.2 在 Android 上不提供可靠的用户手势信息（`navigationType` 固定 `other`），因此本期**不做手势判定**，只做 scheme 白名单：
  - `about:blank` / `data:` 原地加载；
  - `http:` / `https:` / `mailto:` 交给宿主 `openExternalLink`；
  - `file:` / `intent:` / `javascript:` / 自定义 scheme 一律拒绝，不拉起外部 App。
- **仅顶层 frame** 触发外部打开/拒绝：`onShouldStartLoadWithRequest` 先看 `isTopFrame`（iOS 提供；Android 固定 true 且不为子帧触发）。
  - 顶层：按白名单，http(s)/mailto 交给宿主；危险 scheme 拒绝并回调 `onBlockedScheme`。
  - 子帧（iOS `isTopFrame=false`）：http(s)/data/about 放行以正常渲染 iframe；file/intent/javascript 拒绝；**不调用** `openExternalLink`。
- 已知残余风险：页面脚本可主动导航到 http(s) 并触发外部打开；这与现有会话 HTML 预览行为一致，本期不接受该范围扩大（不注入桥、不放宽 scheme）。如后续需要“仅用户点击可外开”，另立注入点击拦截设计。
- iOS/Android 测试分开断言：顶层点击 http(s) 成功；`file:`/`intent:`/`javascript:` 顶层/脚本/meta 被拒绝；iframe 在两端渲染且不拉起外部浏览器；不要求区分 click 与 script。
- `MobileHtmlPreviewFrame` 增加 `onBlockedScheme?(url)`；native 显示 in-frame toast “This link type isn't supported in preview”；web 无 toast（或由 shell 上报），作为已知平台差异。
- 白名单/导航判定放在新模块 `html-preview-scheme.ts`，不修改 `openExternalLink` 契约。

### 8.2 恢复“每次询问”

- 只放在 Browser 设置页；溢出菜单、长按菜单、prefbar 都不提供 Reset。删除原型 prefbar。
- 设置页提供 `Ask / Preview / Source`；写入失败回退并提示。
- 测试：从设置恢复后下次点击重新弹层。

### 8.3 自动弹层计数

- worktree HTML：自动弹层固定展示 Preview/Source 两项；`files.read` 后若 `truncated`，Preview 在页面内禁用并提示，不试图在弹层前 stat。
- `line`/`column` 深链：直接进 Source，不弹层。
- terminal artifact HTML：直接进 Source，不弹层，不提供渲染。
- `availableHtmlOpenActions` 唯一输入：`{ source:'worktree'|'terminalArtifact', previewDisabled, readFailed }`。`hasLineTarget`/route `mode` 只决定初始模式，不参与动作可用性（它们不会隐藏读者仍可切换的模式）。
  - `truncated`：只隐藏 Preview，保留 Source/Copy content（前 512 KB）。
  - `readFailed`：保留 Retry/Save/Open/Copy path，隐藏 Preview/Source/Copy content。
  - terminal artifact：只提供 Source 一个模式动作；“1 个可用 → 直开”仅适用于它。

### 8.4 模式优先级

唯一顺序（不可渲染状态绝对优先）：

```text
source=terminalArtifact / sourceOnly (force source, ignore route.mode)
  > truncated (force source + truncation banner, ignore route.mode/preference)
  > route.mode (explicit)
  > line/column (force source)
  > stored preference (preview|source)
  > ask (auto sheet)
```

- `source=terminalArtifact&mode=preview` 仍进 Source，不提供渲染 tab。
- `mode=preview` + 513 KB：先按 preview 打开，读取后 `truncated` 立即切到 Source 并显示截断横幅；不显示渲染。
- 返回：页面内手动切换只保留在本次页面生命周期；返回不写偏好；再次进入按上述优先级重新决定。
- `MobileFilePreviewBody` 增加 `htmlRenderable` / `sourceOnly` / `truncatedNote` 标志；terminal artifact（可编辑与只读）都 `sourceOnly`，可编辑产物仍显示 Save。

### 8.5 动作与菜单

- 单一动作构造器：文件浏览 `mobile-file-actions.ts` 的 `buildFileActions(target, { context: 'list'|'preview', htmlOpenMode?, capabilities })` 是唯一来源；HTML 不新建动作构造器、不重复保存/打开/复制文案。
- **唯一动作顺序**：`Preview`、`Source`、`Save to phone`、`Open with`、`Copy content`、`Copy path`、`Cancel`（不可用项按能力隐藏）。
- **Preview 去重**：HTML 的 `Preview` 是模式动作（`mode=preview`），取代通用文件 `Preview`；`Source` 紧随其后。`list` 与 `preview` 两个 context 都只生成一个 `Preview`，不出现两个同名项。
- HTML 的 `Copy content` 本期包含：按需读取（≤512 KB），截断时提示；与文件浏览矩阵一致。
- 长按/溢出菜单不显示 remember 开关；从长按选择 Preview/Source 也不写偏好。只有自动弹层（或设置页）写偏好。
- 预览页只有文件浏览提供的右侧 `…` 一个入口；HTML 的 Preview/Source 切换在第二行工具栏。
- 自动弹层的 remember 开关只对 Preview/Source 生效；外部动作不写偏好。
- 动作能力输入统一为 8.3 的 `{ source, hasLineTarget, previewDisabled, readFailed }`；隐藏规则同 8.3，测试状态 05/06 断言完整数组。

### 8.6 相对资源检测

`findRelativeHtmlAssetRefs(html)` 规则：

- 只解析 `src`、`href`、`url(...)`；不覆盖 `srcset`/`poster`（写明限制）。
- 不提示：`http:`、`https:`、`data:`、`mailto:`、`tel:`、`javascript:`、`about:`、`blob:`、协议相对 `//`、`#anchor`、空 `href=""`。
- 提示：相对路径 `./`、`../`、裸文件名，以及根绝对 `/assets/x.css`（在 `about:blank`/`srcdoc` 下同样不可解析）。
- 根绝对路径按“可能无法加载”提示，并在设计限制中说明。
- 单测覆盖上述每类；原型状态列出检测出的实际引用。

### 8.7 测试与原型修订

- 删除所有 Orca 浏览器动作、远程打开、配对桌面环境相关断言；删除无限循环超时、非 UTF-8 报错断言。
- 新增：0 字节、CJK/emoji 内容与文件名、返回/旋转、断线重连、读取失败、无可用 App、512 KB 边界（511/512/513 KB）、偏好=preview + line、route mode=preview + line、`source=terminalArtifact&mode=preview`、`mode=preview`+513 KB、长按不写偏好、溢出恢复 Ask 不存在。
- `C11` 拆成 iOS/Android 两条；`C12/C18` 用可判定断言；C8 补 `http(s)/data`、空文档。
- 原型：删除 header More、文件大小标签、prefbar、未设计的 missing-asset 占位与 blocked 弹层（改为 in-frame toast）；所有状态 04-08 的 More 必须打开同一 ActionSheet；动作顺序按 8.5；补充 Copy content、512 KB 精确文案/禁用态、自动弹层两个模式、设置页行+PickerModal。
- 512 KB 源码截断：`MobileFilePreviewSourceText` 增加 `truncatedNote?`，HTML 传 “Showing first 512 KB”；Markdown 保持现有 “Preview truncated. File size: …”，R2 断言不变。
- 被阻止 scheme：Frame `onBlockedScheme` + native toast 文案断言；web 无 toast/由 shell 上报，记录平台差异。
- 渲染文字选择：`MobileHtmlPreviewFrame` 由 FB-U11 追加 `textInteractionEnabled`（iOS）与链接冲突；Android 依赖 WebView 默认选择。FB-U11 依赖 HT-U6/HT-V1，禁止并行改 Frame；删除重复的 HT-U17。

---

## 9. 修复 01 修订（2026-11-10，独立测试评审 R-01/R-03）

> 本节修正 3.5 与 8.1 中“不注入桥”的旧约束；与上文冲突时以本节为准。

### 9.1 Android `javascript:` 逃逸

- 事实：Android WebView 会自行执行点击的 `javascript:` URL，不调用 `onShouldStartLoadWithRequest`；纯回调单元测试无法发现。
- 新增注入式 DOM 拦截（`html-preview-interception.ts`），在**最早的 `window` 捕获阶段**安装 `click`/`submit` 监听，并保留 `document` 捕获兜底；被拦截事件调用 `preventDefault()` + `stopImmediatePropagation()`，使同 target/同阶段后注册的页面监听器无法抢先。对晚插入的节点同样生效；按同一 `HTML_PREVIEW_EXTERNAL_SCHEMES` 白名单取消 `javascript:`/`file:`/`intent:`/`tel:`/自定义 scheme。
- Android 端最早注册依赖真正的 document-start 注入：repo 的 react-native-webview 补丁在 `injectedJavaScriptBeforeContentLoaded` 上使用 `WebViewCompat.addDocumentStartJavaScript`（特性不支持时回退到 `onPageStarted`）。`injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}` 同时把 fence 注入子帧；`javascript:` 子帧内不再执行，子帧哨兵仍被原生补丁丢弃，不产生宿主 toast。iOS 由 `WKUserScript` document-start 注入。
  - **支持的 WebView 下限：Android System WebView 89+**（`WebViewFeature.DOCUMENT_START_SCRIPT`）。低于 89 或特性不可用时只有 `onPageStarted` fallback：页面脚本先运行，fence 可被提前注册的 window 捕获监听或预置 guard 抢先，且该 fallback 只覆盖主帧。因此“页面无法禁用 fence”只在 document-start 路径成立；fallback 是 best-effort。
- 幂等 guard 使用不可写、不可配置的 `Object.defineProperty`，但它只作为诊断/测试标记，**从不作为跳过安装的条件**。页面预置可写 flag 会被覆盖；预置精确值 `{value:'v2', writable:false, configurable:false}` 时仍安装监听（重复安装无害：最先注册的监听调用 `stopImmediatePropagation`，同 target/同阶段的后注册监听不会执行）。
- **动态 `about:blank` 子帧**：以 `about:blank` 创建、随后用 `document.write`/`contentDocument` 填充的 frame 不发生导航，document-start 不会在其文档中运行。同源父文档的 fence 通过 MutationObserver 在子帧插入时把同一安装函数 eval 到子窗口（含后续 `document.write` 文档，window 监听仍保留），因此点击路径仍被拦截。跨源 frame、CSP 禁止 eval、或父页面在安装前篡改子窗口 `eval`/`Function.prototype.toString` 时无法覆盖；这些情况与父页面自身脚本能力等价，外部 scheme 仍由引擎兜底。**不得声称 document-start 覆盖所有 iframe**。
  - **残余（adoption 顺序）**：子帧创建后在同一任务内同步 `document.write` 的内联脚本会在父观察器微任务之前执行。该脚本可先注册 window 捕获监听并 `stopImmediatePropagation()`（使后注册的 fence 不再运行），或先改写子窗口的 `eval`；带 `allow-scripts` 的 sandbox 帧（opaque origin）同样无法 adoption。这与页面自身脚本能力等价，不是新增权限；单元测试固定了该限制，不声称完全覆盖。
- 表单同时检查 `event.submitter` 的 `formaction`（优先于 `form.action`）。`form.submit()` 不触发 submit 事件，属于残余风险，由原生策略/引擎负责。
- 拦截后通过 `window.ReactNativeWebView.postMessage` 发送**唯一固定哨兵** `orca:html-preview:blocked-scheme`；宿主只接受逐字节相等的该值并触发既有 toast（toast 可见期间忽略重复哨兵，脚本侧另有 400 ms 节流）。不读取/回显 URL，不执行任何宿主动作；页面脚本只能伪造 toast，不能打开链接或访问宿主能力。Repo 的 react-native-webview 补丁会丢弃子帧消息。
- 原生回调并非点击路径的兜底：Android WebView 133 实测对点击的 `javascript:`/`file:`/`intent:`/`tel:` 不调用 `shouldOverrideUrlLoading`（`https` 会调用），因此原生层不能硬拒绝这些点击；可靠边界是 document-start + 最早 window 捕获。脚本发起的 `intent:` 等导航仍由原生回调拒绝并 toast；脚本 `file:` 由引擎静默拒绝（无 toast）。`http(s)` 外开仍是 8.1 已接受的残余风险。

### 9.2 meta refresh 反馈

- 注入脚本在文档开始时解析并移除指向非白名单 scheme 的 `meta refresh`，按原延迟发送同一哨兵，因此出现 “This link type isn't supported in preview” toast；`http(s)` refresh 交给原生回调，同文档 refresh 不改。quoted URL 按 HTML 规范在闭合引号处截断（`"https://safe" extra` 仍允许）。
- 新增的 blocked meta 在 MutationObserver 回调中**同步移除**并按其 delay 发送哨兵；0 延迟 refresh 的导航任务晚于该微任务，因此应用层先移除。观察器同时监听 `meta` 的 `http-equiv`/`content` 属性变化：先 append 元素、后设置 `content`/`http-equiv` 的写法也会在属性变更微任务中被同步移除。节点被移除后页面再次 append 同一节点时仍会再次移除（WeakSet 只用于避免重复 toast，不作为跳过移除的条件）。随后 50 ms debounce 只做全量扫描兜底，避免每个插入节点都做全文档 `querySelectorAll`。
- 若注入未生效（例如 0 延迟 refresh 与 observer 微任务在同一任务边界内被引擎提前调度），原生策略仍安全阻止导航（`intent:` 有 toast；`file:` 可能被引擎静默拒绝），作为兜底；应用层不承诺比引擎更强的保证。
- 子帧策略与原生 `SUBFRAME_SCHEMES`/`isInlineSubframeDocument` 对齐：子帧内仅 `http(s)`、`data:`、`about:srcdoc`、`about:blank`（可带 fragment）放行；`mailto:`/`tel:`/`blob:`/`file:`/自定义 scheme 一律阻止，不交给原生回调。顶层 `about:srcdoc` 仍拒绝。Android 原生回调通过补丁把 `WebResourceRequest.isForMainFrame()` 作为 `isTopFrame` 传给 JS；旧 `String` 重载不带该字段（该重载只覆盖主帧），缺失时沿用既有 top-frame 语义。

### 9.3 测试修正

- 新增拦截脚本测试：在真实 DOM 上 dispatch `click`/`submit`（不只调用回调），覆盖危险/允许 scheme、子节点点击、后插入 anchor、表单、重复注入、meta refresh 的延迟/大小写/属性顺序。
- Frame 契约测试：注入脚本在内容加载前后各一次、存在 `onMessage`、不注入对象桥、仅哨兵触发 toast、任意 payload 被忽略。
- Android 实机必测：点击 `javascript:`/`file:`/`intent:`/自定义 scheme 无执行、无外开、有 toast；`https` 仍外开；iframe 危险链接不外开；meta refresh 有 toast 且不导航。
