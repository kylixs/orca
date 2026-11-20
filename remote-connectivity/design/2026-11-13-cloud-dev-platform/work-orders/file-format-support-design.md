# 云端开发平台简易工作区 · 文件格式支持列表与渲染器架构设计

- 日期：2026-11-15
- 状态：设计稿（只读盘点，不修改代码，不提交 git）
- 范围：`src/renderer/src/cloud/`（简易工作区，U46-7a/7b/8）+ `src/main/runtime` 的文件 RPC 能力边界 + orca web 可复用渲染组件
- 目标：
  1. 可预览格式默认**预览**打开，可切到**源码编辑**；核实当前默认态。
  2. 完整盘点常用文档格式，形成 **L1/L2/L3** 三级支持列表。
  3. 给出 L2 缺失格式的实现方式、依赖、体积与工作量。
  4. 设计**每格式独立 chunk 懒加载 + 全局注册表/工厂复用**的渲染器架构。
  5. 给出 ≤20 分钟、域不相交的实现切分与逐格式 e2e 验收标准。

---

## 0. 结论摘要

1. **当前默认态与需求不一致的只有 Markdown**：`.md/.markdown/.mdx` 走 `editor` 标签，`mode` 初始值是 `'edit'`，即**默认编辑**；HTML 走 `preview` 标签，`htmlMode` 初始值是 `'preview'`，即**默认预览**（源码模式是只读 `<pre>`，不是编辑器）。图片默认预览；PDF 是占位；drawio 是只读源码降级。
2. **L1 已覆盖**：Markdown、HTML、图片（png/jpg/jpeg/gif/webp/bmp/ico/svg）、PDF 占位、drawio 降级、Monaco 代码文本（95 个扩展名 + 21 个文件名映射）、已知二进制占位、未知文本走 Monaco。
3. **L2 建议新增**（按优先级）：CSV/TSV 表格、JSON/JSONC 树、XML 树、YAML 树、Mermaid 图、PDF 真预览、音频/视频、SVG 源码、DOCX、XLSX、EML、AVIF；PPTX 建议维持 L3（无维护良好的浏览器渲染器）。
4. **默认策略**：有预览渲染器且内容未截断 → 默认预览；纯代码/纯文本/无预览 → 默认源码（Monaco）；不支持的二进制 → 占位。用户显式切换后按**渲染器 id** 记在 `sessionStorage`（每会话，不落 localStorage），作为新开标签的初始值；已挂载标签以 React state 为准。
5. **架构**：新建 `cloud/file-renderers/` 注册表，每个格式一个 descriptor `{ id, source, match, defaultMode, component: lazyWithRetry(...) }`。文本格式统一走 `editor` 宿主（读取一次文本，源码 Monaco + 预览渲染器），二进制格式走 `preview` 宿主（`files.readPreview` 或 `files.stat`+`files.readChunk`）。所有标签共享模块级 lazy 身份与已加载 chunk，实例按标签隔离。
6. **不新增 RPC 即可完成 L2 大部分格式**：`files.stat`（取 size）与 `files.readChunk`（512KB/次，base64）已在云端读权限白名单内，可在客户端拼装 Blob 供媒体/Office 使用。媒体大文件仍建议后续做流式能力（本设计只给边界，不展开）。

---

## 1. 现状盘点（只读）

### 1.1 文件点击分发（7b）

入口：`CloudSimpleWorkspace.openFile` → `cloudSimpleWorkspaceTabForFile(path)`。

文件：`src/renderer/src/cloud/cloud-simple-workspace.tsx:113-126`

```ts
export function cloudSimpleWorkspaceTabForFile(path: string): CloudSimpleWorkspaceTab {
  const previewKind = cloudWorkspacePreviewKind(path)
  if (previewKind !== 'binary') {
    return cloudSimpleWorkspaceFileTab(
      path,
      'preview',
      previewKind === 'image' ? 'image' : 'preview'
    )
  }
  if (isCloudWorkspaceBinaryPath(path)) {
    return cloudSimpleWorkspaceFileTab(path, 'preview', 'binary')
  }
  return cloudSimpleWorkspaceFileTab(path) // editor
}
```

`cloudWorkspacePreviewKind`（`cloud-workspace-preview-tab.tsx:114-130`）只识别：

| 判定           | 结果     | 打开方式                                                              |
| -------------- | -------- | --------------------------------------------------------------------- |
| `.html/.htm`   | `html`   | `preview` 标签，默认 iframe 预览                                      |
| `.drawio`      | `drawio` | `preview` 标签，默认只读源码降级                                      |
| 图片扩展白名单 | `image`  | `preview` 标签，默认 data URL 图片                                    |
| `.pdf`         | `pdf`    | `preview` 标签，默认占位（不读取）                                    |
| 其他           | `binary` | 再看 `isCloudWorkspaceBinaryPath`：已知二进制 → 占位；否则 → `editor` |

**结论：Markdown 不在 preview 分支，落到 editor 分支。**

### 1.2 编辑器标签（7a）

文件：`src/renderer/src/cloud/cloud-workspace-file-tab.tsx`

- 读取：`files.read`（`cloud-workspace-file-io.ts:47-73`），宿主上限 512KB；`truncated` / `binary` / NUL 都降级为只读。
- 默认模式：`const [mode, setMode] = React.useState<'edit' | 'preview'>('edit')`（`:91`）。
- 预览开关只对 `isCloudWorkspaceMarkdownPath(path)` 渲染（`:86`、`:225`）。
- 预览分支：`React.lazy` 加载 `cloud-workspace-markdown-preview`，内部复用 `MarkdownPreviewBody`（`cloud-workspace-markdown-preview.tsx:1-31`）。
- 编辑器：`React.lazy` 加载 `cloud-workspace-monaco-editor`，语言来自 `detectLanguage`（`cloud-workspace-file-io.ts:37-39`）。
- 二进制兜底：宿主返回 `binary_file` 错误 → 占位；但宿主返回 `binary:true` 或内容含 NUL → 仍是**只读 Monaco**，不是占位（`:105-126`、`:321-329`）。这是 L1 的一个待修缺口。

**结论：Markdown 当前默认“编辑”，不是“预览”。**

### 1.3 预览标签（7b）

文件：`src/renderer/src/cloud/cloud-workspace-preview-tab.tsx`

- 图片：`previewCloudFile` → `isImage && mimeType.startsWith('image/')` → `buildImageDataUri` → `<img>`（`:173-195`、`:377-385`）。
- HTML：`htmlMode` 初始 `'preview'`；`<iframe sandbox="" referrerPolicy="no-referrer" srcDoc={content}>`（`:197-227`、`:264`）。源码模式是只读 `<pre>`（`:206-214`）。
- drawio：横幅说明“不加载第三方查看器”，下面是只读 `<pre>`（`:229-247`）。
- PDF：直接占位“PDF 预览不在简易版范围”，不读取、不消耗预算（`:350-356`）。
- 其他二进制：占位 + mime/扩展名 + “请下载后打开”（`:387-392`）。
- 读取：`previewCloudFile`（`shared/cloud-file-browser.ts:131-157`）→ `files.readPreview`。
- 没有按 `active` 延迟加载；隐藏标签也会发起读取（`:266-285`）。
- 当前 lazy 边界只有 3 个：Monaco、MarkdownPreview、DiffEditor。预览标签内的图片/HTML/drawio 代码在主 cloud chunk 里，没有做到“每格式独立 chunk”。

**结论：HTML 当前默认“预览”，源码模式只读、不可编辑。**

### 1.4 标签状态机与去重

文件：`src/renderer/src/cloud/cloud-simple-workspace-tabs.ts`

- 四种 kind：`terminal | editor | preview | diff`（`:11`）。
- `editor` 与 `preview` 按 `path` 共享同一个槽位：同文件再次打开只激活，不新增标签（`:61-71`）。
- 因此 **同一文件的“预览”和“源码编辑”不能是两个并存标签**；一个文本文件的两种模式必须由同一个 tab 组件承载。
- 外壳把所有标签都挂载，只用 `hidden` 隐藏（`cloud-simple-workspace.tsx:232-262`），所以隐藏标签的渲染器实例仍然存在，重活需要 `active` 门控。

### 1.5 Monaco 语言映射

文件：`src/renderer/src/lib/language-detect.ts`

- 95 个扩展名 + 21 个文件名/隐藏文件名（Dockerfile、Makefile、CMakeLists.txt、`.env*`、`.gitignore`、shell rc 等）。
- `.md/.mdx` → markdown；`.mmd/.mermaid` → mermaid；`.ipynb` → notebook；`.csv` → csv；`.tsv` → tsv；`.qmd/.rmd/.rmarkdown` → quarto；`.svg` → xml；`.html/.htm` → html。
- 没有单独映射的扩展名回退 `plaintext`。

### 1.6 可复用的 orca web 渲染组件

| 组件                           | 路径                                                  | 复用可行性         | 说明                                                                                                       |
| ------------------------------ | ----------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `MarkdownPreviewBody`          | `components/editor/MarkdownPreviewBody.tsx`           | **已复用**         | 云侧 `cloud-workspace-markdown-preview.tsx` 已用；GFM + rehype-sanitize                                    |
| `CsvViewer` / `CsvPagedViewer` | `components/editor/csv/`                              | **可直接复用**     | 无 store/Electron 依赖；支持只读与表格编辑；列宽用 localStorage                                            |
| `MermaidViewer`                | `components/editor/MermaidViewer.tsx`                 | **可直接复用**     | 无 store 依赖；DOMPurify SVG profile                                                                       |
| `MediaViewer`                  | `components/editor/MediaViewer.tsx`                   | **可复用**         | `window.api` 只在“本地打开”按钮点击时访问；云侧传 `canOpenLocally=false`                                   |
| `PdfViewer`                    | `components/editor/PdfViewer.tsx`                     | **可复用/需适配**  | 依赖 `useAppStore`（keybindings）；云侧用适配器，必要时把 keybindings 改成 props                           |
| `ImageViewer`                  | `components/editor/ImageViewer.tsx`                   | **不建议直接复用** | 静态 import `PdfViewer`，会把 pdfjs 带进图片 chunk；云侧另写轻量 img 渲染器                                |
| `IpynbViewer`                  | `components/editor/IpynbViewer.tsx`                   | **暂缓**           | 依赖 store（字体缩放/worktree 查找），需先解耦                                                             |
| `editor-lazy-views.ts`         | `components/editor/editor-lazy-views.ts`              | **先例**           | 模块级 `lazy()` 单例，正是“全局共享 chunk/身份”的既有做法                                                  |
| `EditorEditFileSurface.tsx`    | `components/editor/EditorEditFileSurface.tsx:106-302` | **形态先例**       | 按 `csvPreview/isBinary/mediaUrl/isImage/isMarkdown/isMermaid/isCsv/isNotebook` 分发，可作为注册表设计参照 |

### 1.7 宿主文件读取能力边界

| RPC                 | 能力                                                          | 上限/形态                                                                                              | 云端权限           |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------ |
| `files.read`        | 文本                                                          | 512KB（`MOBILE_FILE_READ_MAX_BYTES`），超出 `truncated=true`；二进制/NUL 置 `binary`                   | `file:read`        |
| `files.readPreview` | 图片/PDF 返回 base64+mime；文本返回文本；其他二进制返回空内容 | 远端单次 JSON 回复 4MB（`REMOTE_RPC_MAX_CONTENT_BYTES`），base64 解码后约 3.1MB；本地可预览二进制 10MB | `file:read`        |
| `files.stat`        | 文件大小/mtime                                                | `{size,isDirectory,mtime,ctime?}`                                                                      | `file:read`        |
| `files.readChunk`   | 分块 base64 读取                                              | 每次 ≤512KB，返回 `contentBase64/bytesRead/eof`                                                        | `file:read`        |
| `files.write`       | 写文本                                                        | 无 ETag；保存前需重读比对                                                                              | `file:write`       |
| 下载族              | `files.download` 等                                           | 托管项目默认拒绝（AC-10，`downloadRestricted`）                                                        | 不在简易工作区提供 |

关键事实：

- 宿主 `readPreview` 的二进制 MIME 白名单只有图片 + PDF：`src/main/runtime/runtime-file-commands-mobile-file-list-limit.ts:189-199`（`RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES`）。docx/xlsx/pptx/音视频目前都拿不到 base64，只会得到 `{content:'', isBinary:true}`（或直接 `file_too_large`）。
- `files.stat` 与 `files.readChunk` 已在云端读权限白名单：`src/main/cloud-platform/cloud-rpc-permission.ts:24-48`，且都在 `ALL_RPC_METHODS` 中。**因此客户端可以不改宿主，用 stat + chunk 拼装二进制。**
- 平台读配额按项目滚动小时计（U46 设计 §4.8：默认 600 次/64MB 每小时）。分块读取会消耗配额，必须设客户端上限和用户提示。

### 1.8 现状结论表

| 问题                            | 结论                                             | 证据                                                                    |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Markdown 默认打开？             | **编辑**（Monaco 源码）                          | `cloud-workspace-file-tab.tsx:91`；`cloud-simple-workspace.test.tsx:50` |
| HTML 默认打开？                 | **预览**（空 sandbox iframe）；源码只读 `<pre>`  | `cloud-workspace-preview-tab.tsx:197-227,264`                           |
| 图片默认打开？                  | **预览**（data URL）                             | `cloud-workspace-preview-tab.tsx:173-195`                               |
| PDF 默认打开？                  | **占位**，不读取                                 | `cloud-workspace-preview-tab.tsx:350-356`                               |
| drawio 默认打开？               | **只读源码降级**                                 | `cloud-workspace-preview-tab.tsx:229-247`                               |
| CSV/JSON/XML/YAML 默认打开？    | **编辑**（Monaco）                               | `cloudSimpleWorkspaceTabForFile` 落 editor 分支                         |
| 已知二进制默认打开？            | **占位**                                         | `cloud-workspace-preview-tab.tsx:47-101`                                |
| 未知二进制（NUL/宿主 binary）？ | **只读 Monaco**（应改为占位）                    | `cloud-workspace-file-tab.tsx:105-126,321-329`                          |
| 模式切换记忆？                  | **无**；React state 随标签卸载丢失               | `cloud-workspace-file-tab.tsx:91`                                       |
| 每格式独立 chunk？              | **否**；只有 Monaco/Markdown/Diff 三个 lazy 边界 | `cloud-workspace-file-tab.tsx:44-52`、`cloud-workspace-diff-tab.tsx:34` |

---

## 2. 文件格式支持列表（L1/L2/L3）

### 2.1 L1 · 现有实现直接覆盖

“当前默认”指本次盘点时的真实行为；“目标默认”指本设计落地后的行为。

#### 2.1.1 文档/标记/数据

| 格式              | 扩展名                         | MIME                              | 现有实现                                         | 当前默认     | 目标默认            | 需改默认？ | 缺口                                                             |
| ----------------- | ------------------------------ | --------------------------------- | ------------------------------------------------ | ------------ | ------------------- | ---------- | ---------------------------------------------------------------- |
| Markdown          | `.md` `.markdown` `.mdx`       | `text/markdown`                   | editor tab + lazy `MarkdownPreviewBody`          | 编辑         | **预览**            | **是**     | 默认态；MDX 的 JSX 不作为 MDX 编译，按 Markdown + 原始 HTML 处理 |
| Quarto/R Markdown | `.qmd` `.rmd` `.rmarkdown`     | `text/markdown`                   | Monaco `quarto`                                  | 编辑         | 预览（L2 起）       | 是（L2）   | 未加入 `isCloudWorkspaceMarkdownPath`                            |
| HTML              | `.html` `.htm`                 | `text/html`                       | preview tab：空 sandbox iframe；源码只读 `<pre>` | 预览         | 预览                | 否（默认） | 源码不可编辑；应迁到文本宿主，用 Monaco 源码                     |
| drawio            | `.drawio`                      | `application/xml`（非官方）       | preview tab：只读源码 + 降级横幅                 | 源码（降级） | 预览（降级源码）    | 否         | 源码不可编辑；嵌入查看器需第三方脚本，维持不做                   |
| drawio.svg        | `.drawio.svg`                  | `image/svg+xml`                   | 图片预览                                         | 预览         | 预览                | 否         | —                                                                |
| Jupyter Notebook  | `.ipynb`                       | `application/x-ipynb+json`        | Monaco `notebook`（原始 JSON）                   | 编辑         | 编辑                | 否         | 富预览需解耦 `IpynbViewer` 的 store 依赖（L2 可选）              |
| Mermaid           | `.mmd` `.mermaid`              | `text/x-mermaid`（约定）          | Monaco `mermaid`                                 | 编辑         | 预览（L2）          | 是（L2）   | 复用 `MermaidViewer`                                             |
| CSV               | `.csv`                         | `text/csv`                        | Monaco `csv`                                     | 编辑         | 预览（L2）          | 是（L2）   | 表格渲染；复用 `CsvViewer`                                       |
| TSV               | `.tsv`                         | `text/tab-separated-values`       | Monaco `tsv`                                     | 编辑         | 预览（L2）          | 是（L2）   | 同上，分隔符自动识别                                             |
| JSON              | `.json` `.jsonc`               | `application/json`                | Monaco `json`                                    | 编辑         | 预览（L2）          | 是（L2）   | 树视图；`jsonc-parser` 已安装                                    |
| JSONL             | `.jsonl`                       | `application/x-ndjson`            | Monaco `jsonl`                                   | 编辑         | 编辑（L2 可选表格） | 否         | 每行一个 JSON，树视图不适合                                      |
| XML               | `.xml`                         | `application/xml`                 | Monaco `xml`                                     | 编辑         | 预览（L2）          | 是（L2）   | 树视图；`DOMParser`                                              |
| YAML              | `.yaml` `.yml`                 | `application/yaml`                | Monaco `yaml`                                    | 编辑         | 编辑（L2 可选树）   | 可选       | `yaml` 已安装                                                    |
| TOML/INI/conf     | `.toml` `.ini` `.cfg` `.conf`  | `application/toml` / `text/plain` | Monaco `ini`                                     | 编辑         | 编辑                | 否         | 配置类默认源码合理                                               |
| env               | `.env` `.env.local` 等         | `text/plain`                      | Monaco `ini`                                     | 编辑         | 编辑                | 否         | —                                                                |
| SQL               | `.sql`                         | `application/sql`                 | Monaco `sql`                                     | 编辑         | 编辑                | 否         | —                                                                |
| GraphQL           | `.graphql` `.gql` `.prisma`    | `application/graphql`             | Monaco `graphql`                                 | 编辑         | 编辑                | 否         | —                                                                |
| 纯文本/日志/diff  | `.txt` `.log` `.diff` `.patch` | `text/plain`                      | Monaco `plaintext`                               | 编辑         | 编辑                | 否         | —                                                                |

#### 2.1.2 图片/PDF/二进制

| 格式       | 扩展名                                                                                                                                                                                                               | MIME                       | 现有实现                      | 当前默认 | 目标默认            | 需改默认？     | 缺口                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------- | -------- | ------------------- | -------------- | -------------------------------------- |
| PNG        | `.png`                                                                                                                                                                                                               | `image/png`                | data URL `<img>`              | 预览     | 预览                | 否             | 无缩放/平移（可选升级）                |
| JPEG       | `.jpg` `.jpeg`                                                                                                                                                                                                       | `image/jpeg`               | 同上                          | 预览     | 预览                | 否             | —                                      |
| GIF        | `.gif`                                                                                                                                                                                                               | `image/gif`                | 同上                          | 预览     | 预览                | 否             | 动画按浏览器行为                       |
| WebP       | `.webp`                                                                                                                                                                                                              | `image/webp`               | 同上                          | 预览     | 预览                | 否             | —                                      |
| BMP        | `.bmp`                                                                                                                                                                                                               | `image/bmp`                | 同上                          | 预览     | 预览                | 否             | —                                      |
| ICO        | `.ico`                                                                                                                                                                                                               | `image/x-icon`             | 同上                          | 预览     | 预览                | 否             | —                                      |
| SVG        | `.svg`                                                                                                                                                                                                               | `image/svg+xml`            | data URL `<img>`              | 预览     | 预览                | 否             | 源码编辑可作为 L2 可选                 |
| PDF        | `.pdf`                                                                                                                                                                                                               | `application/pdf`          | 占位，不读取                  | 占位     | 占位（L2 真预览）   | L2             | 复用 `PdfViewer`                       |
| 已知二进制 | 48 个扩展：`bin exe dll so dylib zip tar gz tgz bz2 xz 7z rar class jar wasm pyc pyo o a lib node woff woff2 ttf otf mp3 mp4 mov avi mkv wav flac ogg webm sqlite db iso dmg doc docx xls xlsx ppt pptx odt ods odp` | 各自                       | preview tab 占位              | 占位     | 占位（L2 逐项升级） | 否（除 L2 项） | 托管项目不提供下载，占位文案需改       |
| 未知文本   | 无扩展/未知扩展，UTF-8                                                                                                                                                                                               | `text/plain`               | editor tab Monaco `plaintext` | 编辑     | 编辑                | 否             | —                                      |
| 未知二进制 | 无扩展/未知扩展，NUL 或宿主 `binary`                                                                                                                                                                                 | `application/octet-stream` | editor tab 只读 Monaco + 提示 | 只读源码 | **占位**            | **是**         | 应改为占位，可附“仍以文本查看”次级入口 |

#### 2.1.3 Monaco 全语言清单（L1 代码文本）

以下扩展名均由 `detectLanguage` 映射到 Monaco 语言 id，默认源码编辑：

- apex：`.cls` `.trigger` `.apex`
- astro：`.astro`
- bat：`.bat` `.cmd`
- c：`.c` `.h`
- clojure：`.clj`
- cpp：`.cpp` `.cc` `.cxx` `.hpp`
- csharp：`.cs`
- css：`.css`
- dart：`.dart`
- dockerfile：`.dockerfile`
- elixir：`.ex` `.exs`
- erlang：`.erl` `.hrl`
- go：`.go`
- graphql：`.graphql` `.gql` `.prisma`
- haskell：`.hs`
- hcl：`.tf` `.hcl`
- html：`.html` `.htm` `.jsp` `.jspf`
- ini：`.toml` `.ini` `.cfg` `.conf`
- java：`.java`
- javascript：`.js` `.jsx` `.mjs` `.cjs`
- json：`.json` `.jsonc`
- jsonl：`.jsonl`
- kotlin：`.kt` `.kts`
- less：`.less`
- liquid：`.liquid`
- lua：`.lua`
- markdown：`.md` `.mdx`
- mermaid：`.mmd` `.mermaid`
- nim：`.nim` `.nims` `.nimble`
- notebook：`.ipynb`
- php：`.php`
- powershell：`.ps1`
- proto：`.proto`
- python：`.py`
- quarto：`.qmd` `.rmd` `.rmarkdown`
- r：`.r`
- ruby：`.rb`
- rust：`.rs`
- scala：`.scala`
- scss：`.scss`
- shell：`.sh` `.bash` `.zsh` `.fish`
- sol：`.sol`
- sql：`.sql`
- svelte：`.svelte`
- swift：`.swift`
- systemverilog：`.sv` `.svh`
- tsv：`.tsv`
- twig：`.twig`
- typescript：`.ts` `.tsx` `.cts` `.mts`
- typst：`.typ`
- verilog：`.v` `.vh`
- vue：`.vue`
- xml：`.xml` `.svg`
- yaml：`.yaml` `.yml`

文件名映射：`Dockerfile`、`Makefile`、`CMakeLists.txt`、`.gitignore`、`.gitattributes`、`.editorconfig`、`.env`、`.env.local`、`.env.development`、`.env.production`、`.bashrc`、`.bash_profile`、`.bash_login`、`.bash_logout`、`.profile`、`.zshrc`、`.zshenv`、`.zprofile`、`.zlogin`、`.zlogout`。

### 2.2 L2 · 建议新增（按优先级排开发）

> 体积为安装后打包体积的**估算**，以 Vite bundle 报告为准。工作量按“≤20 分钟单令”计；超过的单令继续拆分。

| ID    | 格式          | 扩展名/MIME                                                                                                    | 目标默认            | 实现方式                                                                                                                 | 新依赖/体积                                   | 工作量                         | 前置条件                                              |
| ----- | ------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| L2-01 | CSV/TSV 表格  | `.csv` `text/csv`；`.tsv` `text/tab-separated-values`                                                          | 预览                | 复用 `CsvViewer`/`CsvPagedViewer`；适配 `preferenceKey`、`onContentChange`、`onSave`；只读项目不传回调                   | 无（已有解析器）                              | 2 令（适配 + 测试）            | 文本宿主注册表                                        |
| L2-02 | PDF 真预览    | `.pdf` `application/pdf`                                                                                       | 预览                | 复用 `PdfViewer`（pdfjs-dist 已装）；lazy 适配器；宿主已返回 base64                                                      | 无（`pdfjs-dist` 已有）                       | 2 令（适配 + 测试）            | 远端文件 ≤ 约 3.1MB                                   |
| L2-03 | JSON/JSONC 树 | `.json` `.jsonc` `application/json`                                                                            | 预览                | `jsonc-parser`（已装）解析 + 可折叠树；解析失败回退源码并提示                                                            | 无                                            | 2 令（树组件 + 测试）          | 文本宿主                                              |
| L2-04 | XML 树        | `.xml` `application/xml`                                                                                       | 预览                | 浏览器 `DOMParser` + 元素树；解析失败回退源码                                                                            | 无                                            | 1-2 令                         | 文本宿主                                              |
| L2-05 | YAML 树       | `.yaml` `.yml` `application/yaml`                                                                              | 预览（可选）        | `yaml`（已装）解析后复用 JSON 树                                                                                         | 无                                            | 1 令                           | L2-03                                                 |
| L2-06 | Mermaid 图    | `.mmd` `.mermaid` `text/x-mermaid`                                                                             | 预览                | 复用 `MermaidViewer`（mermaid + DOMPurify 已装）                                                                         | 无                                            | 1 令（renderer + 测试）        | 文本宿主                                              |
| L2-07 | SVG 源码编辑  | `.svg` `image/svg+xml`                                                                                         | 预览 + 源码开关     | 从 base64 解码 UTF-8 → Monaco `xml`；解码后 ≤512KB 才允许编辑/保存                                                       | 无                                            | 1-2 令                         | 图片 base64 已加载                                    |
| L2-08 | 音频/视频     | `audio/mpeg` `audio/wav` `audio/ogg` `audio/flac` `audio/mp4` `video/mp4` `video/webm` `video/quicktime`       | 预览                | HTML5 `<audio>/<video>`；`files.stat` 取 size → `files.readChunk` 分块拼 Blob URL；>2MB 先显示“加载预览”按钮并提示读配额 | 无                                            | 3 令（loader、renderer、测试） | `file:read`；客户端二进制 loader                      |
| L2-09 | DOCX          | `.docx` `application/vnd.openxmlformats-officedocument.wordprocessingml.document`                              | 预览                | `mammoth.convertToHtml({arrayBuffer})` → **DOMPurify 净化** → 沙箱容器；图片由 mammoth 内联为 data URI                   | `mammoth`（约 0.4-0.6MB，含 JSZip）           | 3 令（依赖、renderer、测试）   | 二进制 loader；安全评审                               |
| L2-10 | XLSX/XLS      | `.xlsx` `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`；`.xls` `application/vnd.ms-excel` | 预览                | SheetJS CE 或 `exceljs` 解析；只渲染前 N 行/列 + sheet 选择；单元格按文本渲染，不执行公式                                | `xlsx`（约 0.9-1.2MB）或 `exceljs`（约 1MB+） | 3-4 令                         | 二进制 loader；许可证/漏洞评审（npm `xlsx` 版本偏旧） |
| L2-11 | PPTX          | `.pptx` `application/vnd.openxmlformats-officedocument.presentationml.presentation`                            | 维持 L3             | 无维护良好的浏览器渲染器；如产品坚持，需宿主侧 LibreOffice 转 PDF/图片                                                   | n/a                                           | 暂缓                           | 产品决策 + 宿主工具链                                 |
| L2-12 | EML           | `.eml` `message/rfc822`                                                                                        | 预览（可选）        | `postal-mime` 解析；text/html 正文 DOMPurify 后放空 sandbox iframe；附件列表只显示名称，不提供下载                       | `postal-mime`（约 30-60KB）                   | 2 令                           | 文本/二进制读取；安全评审                             |
| L2-13 | AVIF          | `.avif` `image/avif`                                                                                           | 预览                | 浏览器原生解码；扩展客户端 catalog + 宿主 MIME 白名单                                                                    | 无                                            | 1 令                           | 宿主白名单                                            |
| L2-14 | IPYNB 富预览  | `.ipynb` `application/x-ipynb+json`                                                                            | 预览（可选）        | 复用 `IpynbViewer` 前先解耦 store（字体缩放、worktree 路径改为 props）                                                   | 无                                            | 3 令                           | 重构；否则维持 Monaco 源码                            |
| L2-15 | RTF           | `.rtf` `application/rtf`                                                                                       | 源码/纯文本（可选） | 简易控制字剥离或直接 L3                                                                                                  | 无                                            | 可选                           | 质量风险自负                                          |

#### 2.2.1 依赖评估与取舍

- **mammoth（DOCX）**：BSD-2-Clause，浏览器构建可 `arrayBuffer` 输入，输出 HTML；默认内联图片。必须用 DOMPurify 净化，并处理 `javascript:` 链接。体积与安全风险可接受。
- **SheetJS CE（XLSX）**：Apache-2.0；npm 上的 `xlsx` 版本长期停留在 0.18.x，历史上有原型污染类问题，需锁定版本并跑 `pnpm audit`，或改用 `exceljs`（MIT、体积更大、流式更好）。**不要让单元格内容以 HTML 注入**；用文本节点或自行生成表格。
- **pdfjs-dist（PDF）**：仓库已安装并使用；`PdfViewer` 已带 worker、缩放、搜索。云侧复用是零依赖增量。
- **mermaid / DOMPurify / jsonc-parser / yaml**：均已在仓库依赖中，无新增包。
- **postal-mime（EML）**：体积小；HTML 正文必须净化 + 空 sandbox。
- **PPTX**：没有可靠、维护中的纯浏览器渲染器；服务端转换需要 LibreOffice，和“宿主机只跑 Orca runtime”的边界冲突。建议 L3，除非产品接受宿主安装工具链。

### 2.3 L3 · 明确降级（不提供内容渲染）

| 格式/场景          | 扩展名                                                                                             | 原因                             | 呈现                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| 旧版 Office 二进制 | `.doc` `.xls` `.ppt`                                                                               | OLE 复合文档，无轻量浏览器解析器 | 占位：`不支持预览` + 路径 + “在开发环境打开”                         |
| OpenDocument       | `.odt` `.ods` `.odp`                                                                               | 需要 ZIP + XML 解析；暂不做      | 占位                                                                 |
| PPTX               | `.pptx`                                                                                            | 见 L2-11                         | 占位                                                                 |
| EPUB/MOBI/AZW3     | `.epub` `.mobi` `.azw3`                                                                            | 需要 EPUB 引擎，DRM 不可控       | 占位                                                                 |
| Outlook MSG        | `.msg`                                                                                             | 二进制 OLE，需专用解析           | 占位                                                                 |
| HEIC/HEIF/TIFF     | `.heic` `.heif` `.tiff` `.tif`                                                                     | Chromium 解码不可靠/不一致       | 占位；AVIF 可 L2                                                     |
| 压缩包             | `.zip` `.tar` `.gz` `.tgz` `.bz2` `.xz` `.7z` `.rar`                                               | 不做解包/列表/导出               | 占位                                                                 |
| 字体               | `.woff` `.woff2` `.ttf` `.otf` `.eot`                                                              | 二进制                           | 占位                                                                 |
| 可执行/库/字节码   | `.exe` `.dll` `.so` `.dylib` `.bin` `.class` `.jar` `.wasm` `.pyc` `.pyo` `.o` `.a` `.lib` `.node` | 二进制                           | 占位                                                                 |
| 数据库/镜像        | `.sqlite` `.db` `.iso` `.dmg` `.duckdb`                                                            | 二进制/大文件                    | 占位                                                                 |
| 未知二进制         | 无扩展/未知扩展且 NUL/宿主 `binary`                                                                | 无法判定                         | 占位 + “仍以文本查看”次级入口（只读）                                |
| 密码保护/加密      | 加密 PDF、加密 Office                                                                              | 无法解密                         | 明确提示 `password_protected`，不要伪装损坏                          |
| 非 UTF-8 文本      | GBK/Latin-1 等                                                                                     | 宿主按 UTF-8 解码，可能乱码      | 源码只读提示“编码可能不受支持”；不做自动转码（无可靠探测依赖）       |
| 超大文件           | 文本 >512KB；二进制 >远端约 3.1MB / 本地 10MB                                                      | 传输与内存边界                   | 文本：只读 + 截断提示；二进制：`file_too_large` + 重试/占位          |
| drawio 嵌入查看器  | `.drawio`                                                                                          | 需要第三方脚本，安全策略拒绝     | 保持源码降级                                                         |
| 带脚本 HTML        | `.html`                                                                                            | 安全策略                         | 空 sandbox 预览；脚本不执行                                          |
| 托管项目下载       | 任意                                                                                               | AC-10 默认拒绝下载               | **不要写“请下载后打开”**；改为“托管项目不提供下载，可在开发环境打开” |

> 现状文案问题：预览标签的二进制/PDF 占位写了“请下载后打开”（`cloud-workspace-preview-tab.tsx:355,391`；编辑器宿主的二进制占位同样在 `cloud-workspace-file-tab.tsx:328`），与托管项目禁止下载的 AC-10 语义冲突。本设计建议统一改为“托管项目不提供下载；可在开发环境或本地仓库打开”，并提供“复制相对路径”。

---

## 3. 默认打开模式策略

### 3.1 决策表

| 内容类别                 | 判定                                                                          | 默认模式                                   | 切换                                                         |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| 有预览渲染器且文本未截断 | Markdown/HTML/CSV/JSON/XML/YAML/Mermaid/drawio/IPYNB/图片/PDF/媒体/Office/EML | **预览**                                   | 文本格式可切“源码”；二进制无可编辑源码                       |
| 纯代码/配置/纯文本       | Monaco 语言映射命中，且无预览渲染器                                           | **源码（编辑）**                           | 通常无预览开关                                               |
| 文本被截断               | `files.read.truncated === true`                                               | **源码（只读）** + 截断提示                | 预览可显示但必须带“已截断”警示；默认不选预览，避免误以为完整 |
| 不支持的二进制           | L3                                                                            | **占位**                                   | 可附“仍以文本查看”（只读 Monaco）                            |
| 权限不足                 | 无 `file:read`                                                                | 拒绝态                                     | —                                                            |
| 只读项目                 | 无 `file:write`                                                               | 仍按上述默认；源码 Monaco 只读、无保存按钮 | —                                                            |

### 3.2 记忆策略（最小实现）

- **作用域**：按**渲染器 id**（格式类），不按文件路径。理由：用户对“Markdown 想用源码”这类偏好通常跨文件稳定；按路径会让每个文件都要重新切一次。
- **存储**：`sessionStorage`，key 形如 `cloud-ws:viewer-mode:v1:<rendererId>`，值只接受 `'preview' | 'source'`。不写 `localStorage`：默认态是产品行为，用户一次实验不应永久覆盖；会话内记住即可。
- **优先级**：
  1. 已挂载标签的 React state（用户刚点的切换）。
  2. `sessionStorage` 中的渲染器偏好（标签关闭后重开、同一会话内）。
  3. descriptor 的 `defaultMode`（产品默认策略）。
  4. 不支持的二进制 → 占位。
- **写入时机**：仅在用户显式点击模式按钮时写入；不因内容变化或自动回退写入。
- **边界**：
  - 只对 `canPreview && canEditSource` 的渲染器记忆；纯源码/纯预览不记。
  - 偏好值非法时忽略。
  - 截断/解析失败导致的自动回退不覆盖用户偏好。
  - 刷新页面后 sessionStorage 仍在；关闭该浏览器标签页/新会话后结束，回到产品默认。
- **不做**：不做“全局设置里的默认打开方式”，不做按扩展名细粒度配置，不做 localStorage 持久化（后续有用户诉求再加）。

### 3.3 模式切换的脏缓冲语义

- 文本宿主同时持有 `content`（内存缓冲）与 `baseContent`（磁盘基线）。预览渲染器始终渲染**内存缓冲**，因此未保存的编辑在预览里可见。
- 切换模式**不保存、不丢弃、不重读**。`dirty` 仍由内容与 `baseContent` 比较得出，状态栏与关闭守卫不变。
- 在预览模式下仍应能保存：Monaco 卸载后，Cmd/Ctrl+S 需要宿主级键盘处理（见 §5 的 P1 令），使用平台判定而不是硬编码 `metaKey`。
- 二进制格式无脏状态；不注册保存处理器。

### 3.4 与 orca web 的一致性论证

orca web 的 Markdown 编辑默认就是富预览：`getDefaultMarkdownViewMode` 在 markdown + edit 时返回 `'rich'`（`components/editor/markdown-preview-controls.ts:71-77`）。云侧把 Markdown 默认改成预览，与主编辑器行为一致；代码文件仍默认源码，也与主编辑器一致。

---

## 4. 渲染器架构

### 4.1 目标与非目标

目标：

1. 每格式渲染器**独立 chunk**，只在首次打开该格式时加载。
2. **全局复用**：一个格式一个模块级 lazy 身份；多标签共享同一 chunk，不重复下载、不重复解析依赖。
3. 与现有 7a/7b 宿主最小迁移：保留标签状态机、脏/保存/冲突协议、RPC 边界。
4. 默认模式、模式记忆、逐格式能力（是否可预览、是否可编辑源码、二进制加载方式）都由一个注册表描述。
5. 安全默认：HTML 空 sandbox；Markdown/Office/EML 净化；SVG 只进 `<img>` data URL。

非目标：

- 不做 WYSIWYG 编辑、不做内嵌 IDE 的完整语言服务。
- 不做下载/上传/导出（托管项目 AC-10）。
- 不做宿主侧新流式协议（本设计只给 L2 的兼容路径与后续边界）。
- 不把 `components/editor` 的整个 store 依赖搬进云页面。

### 4.2 模块布局

建议新增（名称按实际职责，不用 `helpers/utils`）：

```text
src/shared/
  cloud-file-format-catalog.ts          # 共享：扩展名/文件名 → 类别、MIME、source(text|binary)、viewerId、默认策略
  cloud-file-format-catalog.test.ts

src/renderer/src/cloud/file-renderers/
  cloud-file-renderer-types.ts          # descriptor / props / content 类型
  cloud-file-renderer-registry.ts       # 有序 descriptor 数组 + resolve() + lazy 身份
  cloud-file-renderer-registry.test.ts
  cloud-viewer-mode-preference.ts       # sessionStorage 读写 + 测试
  markdown-file-renderer.tsx
  html-file-renderer.tsx
  drawio-file-renderer.tsx
  csv-file-renderer.tsx
  json-file-renderer.tsx
  xml-file-renderer.tsx
  yaml-file-renderer.tsx
  mermaid-file-renderer.tsx
  image-file-renderer.tsx
  pdf-file-renderer.tsx
  media-file-renderer.tsx
  docx-file-renderer.tsx
  xlsx-file-renderer.tsx
  eml-file-renderer.tsx
  binary-placeholder-renderer.tsx
  code-file-renderer.tsx               # 包一层现有 cloud-workspace-monaco-editor

src/renderer/src/cloud/
  cloud-workspace-file-io.ts            # 文本读写（保留）
  cloud-workspace-binary-io.ts          # 新增：stat + readChunk + Blob URL
  cloud-workspace-file-tab.tsx          # 文本宿主：改为注册表分发
  cloud-workspace-preview-tab.tsx       # 二进制宿主：改为注册表分发
```

关键约束：

- `cloud-file-renderer-registry.ts` **只能**静态 import 类型、catalog 和 `lazyWithRetry`；不能静态 import 任何 renderer 模块，否则会把所有渲染器打进主 chunk。
- 每个 `*-file-renderer.tsx` 是该格式唯一的动态 import 边界；重依赖（mammoth/xlsx/pdfjs/mermaid）只出现在对应 renderer 模块内部。
- 共享 catalog 可被 main 与 renderer 同时 import（`src/shared` 无 Electron/DOM 依赖）。

### 4.3 类型与注册表契约

```ts
export type CloudFileSourceKind = 'text' | 'binary'

export type CloudFileViewerId =
  | 'markdown'
  | 'html'
  | 'drawio'
  | 'csv'
  | 'json'
  | 'xml'
  | 'yaml'
  | 'mermaid'
  | 'ipynb'
  | 'code'
  | 'image'
  | 'pdf'
  | 'media'
  | 'docx'
  | 'xlsx'
  | 'eml'
  | 'binary'

export type CloudFileMode = 'preview' | 'source'

export type CloudFileFormat = {
  path: string
  fileName: string
  extension: string // 小写，不含点；复合名单独处理
  mimeType: string | null // catalog 合成值；宿主回复后可覆盖
  source: CloudFileSourceKind
  viewerId: CloudFileViewerId
  canPreview: boolean
  canEditSource: boolean
  defaultMode: CloudFileMode | 'placeholder'
}

export type CloudFileRendererProps = {
  path: string
  mode: CloudFileMode
  active: boolean
  readOnly: boolean
  text?: string // source === 'text'
  binary?: { base64: string; mimeType: string | null } // source === 'binary'
  onChange?: (next: string) => void
  onSave?: () => void
}

export type CloudFileRendererDescriptor = {
  id: CloudFileViewerId
  source: CloudFileSourceKind
  /** 复合后缀优先，其次扩展名，再次文件名，最后 MIME。数组顺序即优先级。 */
  match: readonly {
    suffix?: string
    extension?: string
    fileName?: string
    mimeType?: string
  }[]
  canPreview: boolean
  canEditSource: boolean
  defaultMode: CloudFileMode | 'placeholder'
  /** 二进制内容的取法：readPreview 一次取，或 stat + readChunk 拼装。 */
  binaryLoader?: 'preview' | 'chunked'
  component: React.LazyExoticComponent<React.ComponentType<CloudFileRendererProps>>
}
```

解析算法：

1. 取小写文件名；**复合后缀优先**（`.drawio.svg` 先于 `.svg`，`.html.liquid` 先于 `.html`）。
2. 精确文件名匹配（`Dockerfile`、`Makefile`、`.env` 等）。
3. 扩展名匹配。
4. 宿主 MIME 覆盖（仅当宿主明确返回 `mimeType` 且与扩展名冲突时；例如未来宿主识别出真实类型）。
5. 回退：`files.read` 文本启发式命中 → `code`（`plaintext`）；NUL/宿主 binary → `binary` 占位。

两阶段解析：

- **阶段 1（打开标签前，只有路径）**：决定 `source` 与标签 kind。`text` → `editor` 标签；`binary` → `preview` 标签。
- **阶段 2（读取后，拿到 `mimeType/isBinary/truncated`）**：refine `viewerId` 与 `defaultMode`。例如未知扩展名读到了文本 → `code`；读到了二进制 → `binary`；PDF/图片确认 MIME。

### 4.4 文本宿主与二进制宿主

保留两个宿主，避免大改 7a/7b：

| 宿主                        | 负责                                                                     | 内容来源                                              | 现有代码                          |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------- |
| 文本宿主（`editor` tab）    | 文本缓冲、脏状态、保存冲突、只读/截断、源码 Monaco、预览渲染器、模式切换 | `files.read`                                          | `cloud-workspace-file-tab.tsx`    |
| 二进制宿主（`preview` tab） | base64/Blob 装载、图片/PDF/媒体/Office 渲染、错误/重试、大小门槛         | `files.readPreview` 或 `files.stat`+`files.readChunk` | `cloud-workspace-preview-tab.tsx` |

为什么不是单一 `file` tab：

- 两个宿主的读取协议、脏/保存语义、错误模型完全不同；合并会把保存冲突逻辑带进只读二进制，风险高。
- 现有 reducer 已让 editor/preview 按 path 共享槽位，两个宿主已经能表达“同一文件只有一种打开形态”。
- 文本格式的“预览/源码”天然是一个宿主内的模式切换；二进制格式没有源码编辑。

**唯一结构性迁移**：HTML 与 drawio 从二进制宿主迁到文本宿主。原因：

- 它们本质是文本，源码编辑必须用 Monaco；现在的只读 `<pre>` 不满足“可切换到源码编辑”。
- 迁移后 HTML 与 Markdown 共用 `files.read` 一次读取，避免 `readPreview` 的 512KB 文本上限和二次读取。
- 图片/PDF/音视频/Office 仍留在二进制宿主。

### 4.5 懒加载与全局复用

```text
registry (module singleton)
 ├─ markdown descriptor ── lazyWithRetry(() => import('./markdown-file-renderer'))
 ├─ html     descriptor ── lazyWithRetry(() => import('./html-file-renderer'))
 ├─ csv      descriptor ── lazyWithRetry(() => import('./csv-file-renderer'))
 ├─ image    descriptor ── lazyWithRetry(() => import('./image-file-renderer'))
 ├─ pdf      descriptor ── lazyWithRetry(() => import('./pdf-file-renderer'))
 └─ ...
```

规则：

1. **一个 renderer 一个模块级 lazy 身份**。不要在组件里 `React.lazy`（每次渲染都会产生新的组件类型，导致重挂载和重复 chunk 请求）。`editor-lazy-views.ts` 已明确记录过这个坑。
2. **chunk 共享**：模块级 lazy 身份 + 浏览器 module cache = 第一个标签加载后，后续同格式标签直接复用已解析模块，不再发请求。
3. **实例隔离**：每个标签一个渲染器实例（滚动、缩放、展开状态互不干扰）。同一文件不会开两个实例（reducer 按 path 去重）。
4. **隐藏标签门控**：外壳仍挂载所有标签，但 `active=false` 时：
   - 文本宿主不自动发起大文件读取；
   - 二进制宿主不自动发起 `readPreview`/chunk 装载；
   - 首次 `active=true` 才加载，之后保持挂载以保留状态。
5. **共享缓存（可选，v1 不做）**：如后续发现重复解析成本高，可按 `path + size + mtime` 做 LRU（最多 2-3 项）缓存解析结果；不要缓存 base64/Blob 大对象。
6. **错误边界**：每个 lazy 渲染器外层包 `RecoverableRenderErrorBoundary`（`boundaryId='cloud.renderer.<id>'`，`resetKey=path + mode + retryToken`），chunk 加载失败显示重试，不拖垮整个工作区。使用 `lazyWithRetry` 而不是裸 `React.lazy`，与 `cloud-project-workspace.tsx:80-92` 的 chunk 失败恢复先例一致。
7. **重依赖隔离**：
   - `image-file-renderer` 不要 import `ImageViewer`（它静态 import `PdfViewer`，会把 pdfjs 塞进图片 chunk）。
   - `pdf-file-renderer` 才动态 import `PdfViewer`/pdfjs。
   - `docx-file-renderer` 内部才 import `mammoth`；`xlsx-file-renderer` 内部才 import SheetJS。
   - `mermaid-file-renderer` 复用 `MermaidViewer`，mermaid 只在打开图表时加载。

### 4.6 二进制装载策略（L2 关键）

宿主现状：`readPreview` 只对图片/PDF 返回 base64；其他二进制为空。为避免第一阶段改宿主，客户端分两条路：

| 策略      | 适用                            | 实现                                                                                                                 | 边界                                                                                                         |
| --------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `preview` | 图片、PDF、SVG                  | `previewCloudFile` 一次调用                                                                                          | 远端约 3.1MB 解码上限；本地 10MB                                                                             |
| `chunked` | 音视频、DOCX、XLSX、EML（可选） | `files.stat` 取 size → 循环 `files.readChunk`（≤512KB/次，base64）→ 拼 `Uint8Array` → `Blob` → `URL.createObjectURL` | 客户端上限：Office 8MB、媒体 16MB（可配置）；>2MB 先显示“加载预览”按钮并提示读配额；卸载时 `revokeObjectURL` |
| 后续流式  | 大媒体                          | 需要宿主能力协商（新 RPC 或签名 URL）；本设计不展开                                                                  | 老宿主必须优雅降级为占位                                                                                     |

为什么 `chunked` 可行：

- `files.stat` 与 `files.readChunk` 已在云端读权限白名单（`cloud-rpc-permission.ts:24-48`），无需新方法。
- `readFileExplorerChunk` 对 SSH 走 provider range read，对本地走 `readLocalFileRange`，跨主机可用。
- 每块 512KB base64 在 4MB 单次 JSON 预算内。
- 代价：N 次往返 + 读配额。必须在 UI 上明示，不能静默拉 16MB 视频。

### 4.7 与 7a/7b 既有实现的整合（最小迁移）

按顺序执行，每步可独立回滚：

1. **只加 catalog/registry，不改行为**：descriptor 覆盖现有 L1 格式，指向现有渲染代码/占位。测试解析优先序。
2. **分发改走 registry**：`cloudSimpleWorkspaceTabForFile` 用 `resolveCloudFileFormat(path).source` 选 editor/preview；输出与现状一致（除 Markdown 默认态另一步）。
3. **文本宿主接 registry**：`cloud-workspace-file-tab.tsx` 删除 `markdown && mode==='preview'` 硬编码，改为 `resolve()` + lazy renderer；Markdown 默认 `preview`；通用模式按钮。
4. **二进制宿主接 registry**：`cloud-workspace-preview-tab.tsx` 删除 `kind` switch，改为 descriptor 的 binary renderer；`preview` tab 的 `mode` 字段改为 `viewerId`。
5. **HTML/drawio 迁到文本宿主**：删除 preview tab 里的 HTML/drawio 分支；新增两个 renderer；更新 e2e。
6. **L2 逐格式加 descriptor + renderer**：每个格式一个独立令（见 §5）。
7. **删除重复表**：`IMAGE_MIME_BY_EXTENSION`、`CLOUD_WORKSPACE_BINARY_EXTENSIONS`、main 的 `RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES` 与 `src/main/git/.../previewable-binary-mime-types.ts` 收敛到共享 catalog（最后一个令，跨域需单独评审）。

不采用的方案：

- **大爆炸式统一 `file` tab**：改动 reducer、脏协议、保存冲突、关闭守卫和全部测试，收益只是少一个 kind；风险不成比例。
- **iframe/webview 通用预览**：需要外部查看器脚本或宿主服务，违背当前空 sandbox 安全策略。
- **每个标签各自 `React.lazy`**：会造成重复 chunk 请求和重挂载，直接违背“全局复用”。

### 4.8 安全与健壮性

| 面         | 规则                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| HTML       | 继续 `sandbox=""`（无 `allow-scripts`、无 `allow-same-origin`）；不解析相对资源；源码模式用 Monaco，不用 `dangerouslySetInnerHTML` |
| Markdown   | 继续 `MarkdownPreviewBody` + `rehype-sanitize`；链接 `javascript:` 被 URL transform 丢弃；云侧 target=`_blank` + `rel=noreferrer`  |
| DOCX       | mammoth 输出必须 DOMPurify 净化；禁止 `javascript:`/`data:text/html` 链接；图片只允许 data:image                                   |
| XLSX       | 单元格按文本渲染；不把 `sheet_to_html` 原样注入；公式不求值；限制行列数                                                            |
| EML        | 正文 HTML 先 DOMPurify，再进空 sandbox iframe；不自动加载远程图片（隐私）                                                          |
| SVG        | 只作为 `<img>` data URL 或 DOMPurify SVG profile；不内联注入文档                                                                   |
| Mermaid    | 复用现有 `MermaidBlock` 的 DOMPurify SVG profile；`htmlLabels:false`                                                               |
| 媒体       | Blob URL 用完 revoke；不自动播放；`preload='metadata'`；编解码不支持时显示明确错误                                                 |
| 二进制占位 | 不提供下载控件；不调用 `files.download`/`browser.download`；文案不承诺下载                                                         |
| 权限       | 无 `file:read` 零 RPC；无 `file:write` 只读且无保存；所有新渲染器沿用宿主权限判定                                                  |
| 老宿主     | 新 MIME/新格式拿不到内容时显示占位，不崩溃、不空内容伪装成功                                                                       |
| 大文件     | 文本 512KB 截断只读；二进制按 `preview`/`chunked` 上限；`file_too_large` 如实显示                                                  |
| 读配额     | chunked >2MB 需用户点击确认；UI 提示“将消耗项目读取配额”                                                                           |

---

## 5. 实现切分（每令 ≤20 分钟，域不相交）

> 约定：同一“域”的令**串行**；不同域可并行。每令只改一个域，测试与该域同令或紧随其后。Office/媒体等大格式拆成“依赖 + renderer + 测试”多个 ≤20 分钟切片。
>
> 例外说明：新增一个格式时，通常要同时改 **D2**（在 registry 加一行 descriptor）和 **D6**（新增 `*-file-renderer.tsx`）。D2 的 descriptor 行按令**串行**合入，D6 文件彼此不相交；如果要求严格单域，可把“加 descriptor 行”再拆成紧随其后的 D2 令。下文 P1/P2/P3 的格式令默认按“D2 串行 + D6 独立”执行。

### 5.1 域划分

| 域                 | 文件                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| D1 共享 catalog    | `src/shared/cloud-file-format-catalog.ts`                                                                                 |
| D2 注册表/模式偏好 | `cloud/file-renderers/cloud-file-renderer-types.ts`、`cloud-file-renderer-registry.ts`、`cloud-viewer-mode-preference.ts` |
| D3 文本宿主        | `cloud-workspace-file-tab.tsx`、`cloud-workspace-file-io.ts`                                                              |
| D4 二进制宿主/装载 | `cloud-workspace-preview-tab.tsx`、`cloud-workspace-binary-io.ts`                                                         |
| D5 外壳/标签状态   | `cloud-simple-workspace.tsx`、`cloud-simple-workspace-tabs.ts`                                                            |
| D6 单格式 renderer | 每个 `*-file-renderer.tsx` 一个域                                                                                         |
| D7 宿主 MIME/能力  | `src/main/runtime/...`（仅 Phase B）                                                                                      |
| D8 验收/夹具       | `cloud-admin/*.e2e.test.ts`、fixtures、evidence                                                                           |
| D9 依赖清单        | `package.json`、`pnpm-lock.yaml`                                                                                          |

### 5.2 令清单

#### P0 · 基础设施（不改用户可见行为）

| 令   | 域  | 内容                                                                               | 验收                                                                          | 依赖   |
| ---- | --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| P0-1 | D1  | 新建共享 catalog：类别、MIME、`source`、`viewerId`、复合后缀；先只覆盖现有 L1 格式 | `pnpm test src/shared/cloud-file-format-catalog.test.ts`                      | —      |
| P0-2 | D2  | 新建 descriptor 类型 + 空 registry + resolve 算法；descriptor 先指向现有代码/占位  | registry 解析测试：`.drawio.svg`、大小写、`Dockerfile`、未知扩展名、MIME 覆盖 | P0-1   |
| P0-3 | D2  | 模式偏好 `sessionStorage` 读写（key、校验、默认）                                  | 单测：合法/非法/缺失/覆盖                                                     | P0-2   |
| P0-4 | D5  | 预览 tab 的 `mode` → `viewerId`；dispatch 改走 catalog 的 `source`；保持现有输出   | `cloud-simple-workspace.test.tsx` 全绿（除计划内的默认态变更）                | P0-1/2 |
| P0-5 | D3  | 文本宿主按 registry 解析默认模式；Markdown 默认改 `preview`                        | `cloud-workspace-file-tab.test.tsx`：md 默认预览、代码默认源码、切换可用      | P0-2/3 |

#### P1 · 宿主整合与 L1 缺口

| 令    | 域  | 内容                                                                                             | 验收                                                            | 依赖      |
| ----- | --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------- |
| P1-1  | D3  | 删除 Markdown 硬编码，改为 registry lazy renderer + 通用模式切换                                 | 现有 markdown 测试改为默认预览；切换源码编辑/保存               | P0-5      |
| P1-2  | D3  | 宿主 `binary:true`/NUL 改为二进制占位；附“仍以文本查看”次级入口                                  | 只读占位、无保存、可切文本                                      | P1-1      |
| P1-3  | D3  | 预览模式下的 Cmd/Ctrl+S 宿主级保存（平台判定）                                                   | 预览态按键触发 `files.write`；Mac/Win 分支测试                  | P1-1      |
| P1-4  | D6  | `markdown-file-renderer.tsx`：包 `MarkdownPreviewBody`                                           | 渲染标题/列表/表格/代码；脚本不执行                             | P1-1      |
| P1-5  | D6  | `html-file-renderer.tsx`：iframe sandbox + 源码模式（文本宿主 Monaco）                           | sandbox 无 allow-scripts；源码可编辑保存                        | P1-1      |
| P1-6  | D6  | `drawio-file-renderer.tsx`：降级横幅 + 源码模式                                                  | 默认降级源码；源码可编辑                                        | P1-1      |
| P1-7  | D4  | 二进制宿主接 registry；删除 kind switch；图片/PDF/占位 descriptor                                | 现有图片/PDF/二进制测试全绿                                     | P0-4      |
| P1-8  | D6  | `image-file-renderer.tsx`：轻量 `<img>`（不 import ImageViewer）                                 | 图片渲染、失败占位；chunk 不含 pdfjs                            | P1-7      |
| P1-9  | D6  | `pdf-file-renderer.tsx`：lazy 适配 `PdfViewer`；替换占位                                         | PDF 页渲染；密码/超大错误；chunk 才加载 pdfjs                   | P1-7      |
| P1-10 | D1  | HTML/drawio 的 catalog `source` 翻为 `text`（P0-4 的 dispatch 已读 catalog，自动生效）；更新 e2e | HTML/drawio 打开 `editor` 标签；源码可编辑；旧 preview 分支删除 | P1-5/P1-6 |

#### P2 · 常用文本格式

| 令   | 域  | 内容                                                                                            | 验收                                        | 依赖 |
| ---- | --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ---- |
| P2-1 | D6  | `csv-file-renderer.tsx`：复用 `CsvViewer`，接 `onChange/onSave`                                 | 表格默认预览；source 切换；编辑保存；分隔符 | P1-1 |
| P2-2 | D6  | `json-file-renderer.tsx`：jsonc-parser + 可折叠树                                               | 默认树；source；非法 JSON 回退源码          | P1-1 |
| P2-3 | D6  | `xml-file-renderer.tsx`：DOMParser + 树                                                         | 默认树；source；非法 XML 回退               | P1-1 |
| P2-4 | D6  | `yaml-file-renderer.tsx`：yaml + 复用 JSON 树                                                   | 默认树；source                              | P2-2 |
| P2-5 | D6  | `mermaid-file-renderer.tsx`：复用 `MermaidViewer`                                               | 默认图；source；非法图错误                  | P1-1 |
| P2-6 | D1  | `.qmd/.rmd/.rmarkdown` 归入 markdown 家族（catalog 取代 `isCloudWorkspaceMarkdownPath` 硬编码） | 默认 Markdown 预览                          | P1-1 |
| P2-7 | D6  | `svg` 源码模式：base64 解码 → Monaco xml（≤512KB）                                              | 图片默认；源码切换；过大只读                | P1-8 |

#### P3 · 二进制/媒体/Office

| 令    | 域  | 内容                                                                                       | 验收                                  | 依赖      |
| ----- | --- | ------------------------------------------------------------------------------------------ | ------------------------------------- | --------- |
| P3-1  | D4  | `cloud-workspace-binary-io.ts`：stat + readChunk 循环、上限、取消、Blob URL                | 单测：块顺序、eof、上限、错误、revoke | P0-1      |
| P3-2  | D4  | 二进制宿主接 `chunked` loader；>2MB 用户确认；读配额提示                                   | 小文件自动加载；大文件按钮；取消      | P3-1      |
| P3-3  | D6  | `media-file-renderer.tsx`：复用 `MediaViewer` + Blob URL                                   | 音频/视频播放；不支持编解码提示       | P3-2      |
| P3-4  | D9  | 安装 `mammoth`（单独依赖令，含 `pnpm audit`）                                              | 依赖锁定、构建通过                    | —         |
| P3-5  | D6  | `docx-file-renderer.tsx`：mammoth + DOMPurify                                              | 标题/段落/列表/图片；XSS 负向         | P3-2/P3-4 |
| P3-6  | D9  | 选定 XLSX 库（SheetJS CE 或 exceljs）并锁定版本                                            | 依赖锁定、审计                        | —         |
| P3-7  | D6  | `xlsx-file-renderer.tsx`：sheet 选择 + 前 N 行/列 + 文本单元格                             | 表格渲染、行列上限、公式不执行        | P3-2/P3-6 |
| P3-8  | D9  | （可选）安装 `postal-mime` 并锁定版本                                                      | 依赖锁定、审计                        | —         |
| P3-8b | D6  | （可选）`eml-file-renderer.tsx`：postal-mime + DOMPurify                                   | 净化正文、附件列表无下载              | P3-2/P3-8 |
| P3-9  | D7  | （Phase B，可选）宿主 `readPreview` 增加可选二进制 opt-in 或共享 catalog；老客户端优雅降级 | 真栈：新参数/新 MIME；老客户端占位    | 产品评审  |

#### P4 · 验收

| 令   | 域  | 内容                                                             | 验收                                | 依赖     |
| ---- | --- | ---------------------------------------------------------------- | ----------------------------------- | -------- |
| P4-1 | D8  | 格式矩阵 e2e 夹具（文本族：md/html/csv/json/xml/mermaid/drawio） | 每格式默认模式 + 渲染 + 切换 + 保存 | P2       |
| P4-2 | D8  | 格式矩阵 e2e 夹具（二进制族：图片/pdf/媒体/office/二进制/超大）  | 渲染/占位/大小门槛/权限             | P3       |
| P4-3 | D8  | lazy chunk + 模式记忆 + 安全负向断言                             | 见 §6.3                             | P4-1/2   |
| P4-4 | D8  | evidence JSON + 验收索引更新（只改文档）                         | 证据可复跑                          | P4-1/2/3 |

> 说明：P3-4、P3-6、P3-8 是依赖令，不写业务代码；若依赖评审不通过，L2-09/L2-10/L2-12 自动降级为 L3，其他令不受影响。

---

## 6. 验收标准

### 6.1 逐格式断言矩阵

| 格式（夹具）                              | 打开断言            | 默认模式断言                  | 内容断言                                           | 切换/编辑断言                                                        | 负向断言                                         |
| ----------------------------------------- | ------------------- | ----------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| `README.md`（标题/列表/代码块/表格/链接） | 打开 `editor` 标签  | **预览**可见，Monaco 不在 DOM | 标题、列表、代码高亮块、表格、链接渲染             | 切源码 → Monaco `markdown`；修改后 dirty；保存成功；切回预览见新内容 | `<script>` 不执行；`javascript:` 链接被清除      |
| `index.html`（含 `<script>`）             | 打开 `editor` 标签  | **预览**                      | iframe `sandbox=""`、`srcdoc` 等于缓冲、脚本不执行 | 切源码 → Monaco `html`；可编辑保存；切回 iframe 更新                 | sandbox 不含 `allow-scripts`/`allow-same-origin` |
| `logo.png` / `icon.svg`                   | 打开 `preview` 标签 | 图片可见                      | `src` 为 `data:image/...;base64,...`；alt=文件名   | 无源码切换（SVG 可选 L2-07）                                         | 损坏图片显示占位                                 |
| `spec.pdf`                                | 打开 `preview` 标签 | PDF 渲染                      | 页数/首页文本可见；缩放按钮可用                    | 无源码切换                                                           | 密码/超大 PDF 显示明确错误                       |
| `flow.drawio`                             | 打开 `editor` 标签  | **预览**（降级源码）          | 横幅说明不加载第三方；源码内容完整                 | 切源码 → Monaco `xml`；可编辑                                        | 不请求任何第三方脚本                             |
| `src/a.ts` / `app.py`                     | 打开 `editor` 标签  | **源码**                      | Monaco 语言正确；无预览按钮                        | 编辑 + 保存                                                          | —                                                |
| `data.csv` / `data.tsv`                   | 打开 `editor` 标签  | **预览**（表格）              | 行/列数、表头、分隔符正确                          | 切源码 → Monaco `csv/tsv`；表格编辑→保存                             | 只读项目无编辑                                   |
| `config.json` / `config.jsonc`            | 打开 `editor` 标签  | **预览**（树）                | 键值/数组可展开；类型显示                          | 切源码 → Monaco `json`                                               | 非法 JSON → 源码 + 错误提示                      |
| `pom.xml`                                 | 打开 `editor` 标签  | **预览**（树）                | 元素/属性可展开                                    | 切源码 → Monaco `xml`                                                | 非法 XML → 源码 + 错误提示                       |
| `config.yml`（可选）                      | 打开 `editor` 标签  | **预览**（树）                | 键值/嵌套正确                                      | 切源码 → Monaco `yaml`                                               | 非法 YAML → 源码 + 错误提示                      |
| `diagram.mmd`                             | 打开 `editor` 标签  | **预览**（图）                | SVG/文本节点渲染；无脚本                           | 切源码 → Monaco `mermaid`                                            | 非法图 → 错误占位，不崩                          |
| `clip.mp4` / `voice.mp3`                  | 打开 `preview` 标签 | 播放器                        | 控制条、时长、播放/暂停                            | 无源码切换                                                           | >2MB 先按钮；超大/编解码不支持明确提示           |
| `sample.docx`                             | 打开 `preview` 标签 | 渲染 HTML                     | 标题/段落/列表/内联图片                            | 无源码切换                                                           | 内嵌脚本/`javascript:` 链接被清除                |
| `sample.xlsx`                             | 打开 `preview` 标签 | 表格                          | sheet 选择、前 N 行/列、文本单元格                 | 无源码切换                                                           | 公式不求值；超大行列截断提示                     |
| `note.eml`（可选）                        | 打开 `preview` 标签 | 正文                          | 文本/HTML 正文、附件名列表                         | 无源码切换                                                           | 远程图片不自动加载；无下载控件                   |
| `app.exe` / `archive.zip`                 | 打开 `preview` 标签 | 占位                          | 扩展名/MIME + “托管项目不提供下载”                 | 无                                                                   | 不出现下载/导出控件                              |
| `notes.unknown`（UTF-8）                  | 打开 `editor` 标签  | 源码                          | Monaco `plaintext`                                 | 编辑 + 保存                                                          | —                                                |
| `data.unknown`（含 NUL）                  | 打开 `preview` 标签 | 占位                          | 二进制提示                                         | 可选“仍以文本查看”                                                   | 默认不进 Monaco                                  |
| `huge.md`（>512KB）                       | 打开 `editor` 标签  | **源码（只读）**              | 截断提示“文件过大（已截断）”                       | 无保存；预览若可切需带截断警示                                       | 绝不写回截断内容                                 |
| `huge.pdf` / `huge.mp4`                   | 打开 `preview` 标签 | 占位/错误                     | `file_too_large` 或大小门槛                        | —                                                                    | 不静默返回空内容                                 |
| 无 `file:read`                            | 标签                | 拒绝态                        | “未授予文件读取权限”                               | 零 RPC                                                               | —                                                |
| 无 `file:write`                           | 标签                | 按默认模式                    | Monaco 只读、无保存按钮                            | 不能保存                                                             | —                                                |
| 老宿主（媒体/docx 返回空 binary）         | `preview` 标签      | 占位                          | “当前宿主不支持该格式预览”                         | 不崩溃                                                               | 无未捕获异常                                     |

### 6.2 默认态与记忆断言

1. 打开 `README.md` → 预览可见；`cloud-workspace-file-tab-mode-preview` 的 `aria-pressed='true'`。
2. 打开 `src/a.ts` → Monaco 可见；无模式按钮。
3. 打开 `data.csv` → 表格可见；源码按钮存在。
4. 在 Markdown 标签点“源码” → 关闭标签 → 重新从文件树打开同一文件 → **源码**（sessionStorage 记住）。
5. 新开浏览器会话/清 sessionStorage → 再打开 → **预览**（产品默认）。
6. 切换模式后未保存内容仍在；`setDirty` 不被清除；保存后 `dirty=false`。
7. 只读/截断/解析失败导致的回退不写偏好。

### 6.3 懒加载与全局复用断言

1. 首次打开 PNG：网络/资源条目出现 `image-file-renderer-*.js`（Vite 按模块名生成 chunk 名）；主 bundle 不包含 mammoth/pdfjs。
2. 打开第二个 PNG：不再请求同一个 renderer chunk；只有内容读取 RPC。
3. 首次打开 PDF：才出现 `pdf-file-renderer-*.js` 及 pdfjs worker；打开图片不加载 pdfjs。
4. 首次打开 DOCX：才出现 `docx-file-renderer-*.js` 和 mammoth chunk。
5. 隐藏标签首次挂载不发起 `files.readPreview`/`readChunk`；切到该标签时才发起。
6. chunk 加载失败：显示重试；重试走 `lazyWithRetry` 的恢复路径，不白屏。

资源断言建议用 Playwright CDP 的 `Network`/`performance.getEntriesByType('resource')`，按 `*-file-renderer-` 名称族过滤；不要断言完整 hash。

### 6.4 证据与命令

- 组件/单测：`pnpm test src/renderer/src/cloud/...`
- 类型：`pnpm tc`
- 真栈 e2e：扩展 `src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts`，沿用真实平台 + TLS 宿主 + 临时仓库的方式；每格式输出 evidence JSON 到 `remote-connectivity/design/2026-11-13-cloud-dev-platform/test-reports/evidence/file-formats/`。
- 浏览器验收：按 AGENTS.md，`ORCA_BACKGROUND_LAUNCH=1`，隐藏渲染 + CDP 截图，不 `show()`/`focus()`。

---

## 7. 风险与开放问题

| 风险/问题                                     | 影响                                                          | 建议                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 远端 `readPreview` 只返回图片/PDF             | 音视频/Office 无内容                                          | 用 `stat + readChunk` 客户端拼装（Phase A）；大媒体再设计流式（Phase B）                                     |
| 4MB JSON 回复上限                             | PDF/图片/Office 超过约 3.1MB 无法一次取回                     | 客户端上限 + 明确错误；大文件降级占位                                                                        |
| 读配额 600 次/64MB 每小时                     | chunked 预览可能耗尽配额                                      | >2MB 需确认；UI 显示消耗；限制并发与缓存                                                                     |
| 老宿主不认识新 MIME                           | 新格式拿不到内容                                              | 占位 + “当前宿主不支持”；不做静默空内容                                                                      |
| 新宿主 + 老客户端（Phase B 扩展 MIME 白名单） | 老客户端会收到更大的 base64，但仍按二进制占位，安全但浪费带宽 | 优先用**可选参数 opt-in**（新客户端才请求二进制），不要只改宿主发布内容；老客户端保持现有 `readPreview` 语义 |
| 新客户端 + 老宿主（新可选参数被忽略）         | 新格式拿不到内容                                              | 老宿主按缺省行为返回空/占位；客户端不得把空内容当成成功预览                                                  |
| SheetJS npm 版本旧/漏洞                       | 供应链安全                                                    | 锁定版本 + `pnpm audit`；或改用 exceljs；不通过则 L3                                                         |
| mammoth 输出 HTML                             | XSS                                                           | DOMPurify + 链接协议白名单 + 空 sandbox                                                                      |
| `PdfViewer` 依赖 `useAppStore`                | 云页面 store 未初始化时行为不确定                             | 先用适配器验证；必要时把 keybindings 改成 props（web 侧小重构）                                              |
| `ImageViewer` 静态 import `PdfViewer`         | 图片 chunk 被 pdfjs 污染                                      | 不复用 `ImageViewer`，云侧写轻量 img renderer                                                                |
| HTML 相对资源不解析                           | 用户以为能看到完整页面                                        | 预览横幅说明“文档级预览，不是本地 dev server”；后续可评估受控资源代理（不在本设计）                          |
| MDX 不是真 MDX                                | JSX 组件不渲染                                                | 当前按 Markdown 处理；在格式列表标注限制                                                                     |
| 非 UTF-8 文本                                 | 乱码                                                          | 只读提示；不做自动编码探测                                                                                   |
| 托管项目“请下载后打开”文案                    | 与 AC-10 冲突                                                 | 统一改为“托管项目不提供下载；可在开发环境打开” + 复制路径                                                    |
| 预览模式无 Cmd/Ctrl+S                         | 用户以为不能保存                                              | 宿主级保存快捷键（P1-3）                                                                                     |

开放问题（需产品/架构确认）：

1. `docx/xlsx` 是否值得引入 ~1MB 级依赖，还是维持 L3 + 下载策略（托管项目又无下载）？
2. 媒体预览是否允许消耗读配额自动加载，还是必须用户点击？本设计默认 >2MB 点击。
3. 是否需要在格式列表之外提供“用源码打开”的全局入口（例如图片/SVG）？
4. PPTX 是否接受宿主侧转换工具链？若不接受，明确 L3。
5. 模式偏好是否要跨会话持久化？本设计选择 sessionStorage，若用户反馈强烈再升 localStorage + 设置项。

---

## 8. 附：设计决策记录（ADR 摘要）

| 决策             | 选择                            | 理由                                           | 替代方案（否决）                                                 |
| ---------------- | ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| 标签模型         | 保留 editor/preview 两宿主      | 与 7a/7b 脏/保存/读取协议一致，迁移最小        | 统一 `file` kind（改动面大）                                     |
| 默认模式         | 可预览 → 预览；代码 → 源码      | 用户需求 + 与 orca web Markdown 默认 rich 一致 | 全部默认源码（不满足需求）；全部默认预览（代码不可编辑语义混乱） |
| 模式记忆         | sessionStorage，按 viewerId     | 最小实现、可预测、不永久覆盖产品默认           | localStorage 按路径（粘性过强、每文件重复）                      |
| HTML/drawio 归属 | 迁到文本宿主                    | 源码编辑必须 Monaco；共用一次 `files.read`     | 留在 preview 标签 + 只读 pre（不满足源码编辑）                   |
| 二进制大文件     | 客户端 `stat+readChunk` 拼 Blob | 无需改宿主/RPC，跨 SSH 可用                    | 新流式 RPC（需能力协商，后续）                                   |
| 图片渲染器       | 云侧轻量 `<img>`                | 避免 `ImageViewer` 把 pdfjs 带进图片 chunk     | 直接复用 `ImageViewer`（chunk 污染）                             |
| PDF 渲染器       | lazy 适配 `PdfViewer`           | pdfjs 已装、功能完整                           | 重写 PDF viewer（浪费）                                          |
| 模式切换 chunk   | 模块级 lazy 单例                | 多标签共享 chunk，避免重挂载                   | 组件内 `React.lazy`（重复请求）                                  |

---

## 9. 参考文件索引

- 分发：`src/renderer/src/cloud/cloud-simple-workspace.tsx:113-126`
- 文本宿主：`src/renderer/src/cloud/cloud-workspace-file-tab.tsx:44-52,86-91,225-246,318-353`
- 预览宿主：`src/renderer/src/cloud/cloud-workspace-preview-tab.tsx:28-130,197-247,350-393`
- 文本 IO/语言：`src/renderer/src/cloud/cloud-workspace-file-io.ts:36-45`
- 语言映射：`src/renderer/src/lib/language-detect.ts`
- Markdown 复用：`src/renderer/src/cloud/cloud-workspace-markdown-preview.tsx`
- 标签状态机：`src/renderer/src/cloud/cloud-simple-workspace-tabs.ts:11-198`
- 懒加载先例：`src/renderer/src/components/editor/editor-lazy-views.ts`
- 视图分发先例：`src/renderer/src/components/editor/EditorEditFileSurface.tsx:106-302`
- Web Markdown 默认：`src/renderer/src/components/editor/markdown-preview-controls.ts:71-77`
- PDF：`src/renderer/src/components/editor/PdfViewer.tsx`
- CSV：`src/renderer/src/components/editor/csv/CsvViewer.tsx`
- Mermaid：`src/renderer/src/components/editor/MermaidViewer.tsx`
- Media：`src/renderer/src/components/editor/MediaViewer.tsx`
- 宿主 MIME 白名单：`src/main/runtime/runtime-file-commands-mobile-file-list-limit.ts:189-199`
- 宿主 preview 实现：`src/main/runtime/runtime-file-commands-read-file-explorer-preview.ts:35-106`
- 云端读权限白名单：`src/main/cloud-platform/cloud-rpc-permission.ts:24-48`
- `files.stat` / `files.readChunk`：`src/main/runtime/rpc/methods/files.ts:131-141,214-218`
- 测试：`src/renderer/src/cloud/cloud-workspace-file-tab.test.tsx:316-359`、`cloud-workspace-preview-tab.test.tsx:71-210`、`cloud-simple-workspace.test.tsx:38-56`、`src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts`

## 主会话审定（2026-11-16）

全盘采纳：①默认策略（有预览渲染器→默认预览；纯代码/文本→Monaco；用户切换按渲染器 id 记 sessionStorage）；②渲染器注册表架构（`cloud/file-renderers/` 模块级注册表+descriptor+lazyWithRetry 独立 chunk+多标签共享 chunk）；③L2 分批：首批=CSV/TSV 表格+JSON/XML/YAML 树+Mermaid 图+PDF 真预览+AVIF（零外部依赖或既有栈可承）；二批=音视频+DOCX/XLSX（外部库需安全评审另批）+EML；PPTX 维持 L3。实现令 FS-1（注册表重构+md 默认态改预览+未知二进制占位）→FS-2（首批渲染器）→FS-3（e2e 逐格式）。
