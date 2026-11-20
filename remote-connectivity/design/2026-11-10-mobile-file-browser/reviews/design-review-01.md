# 设计评审 01 — 文件浏览

评审范围：`design.md`、`test-plan.md`、`tasks.md`、`ui-prototypes/file-actions.html`、`ui-prototypes/index.html`，并对照了同批的 HTML 打开方式与终端链接/选区设计，以及移动端现有文件树、预览、媒体下载、搜索和 OTA shell 实现。

结论：REJECTED

Findings 统计：BLOCKER 2 / MAJOR 17 / MINOR 11。

## Findings

### 平台可行性

- [BLOCKER] Android“下载到手机”没有可靠的保存落点 — `expo-sharing` 的 `shareAsync` 只打开分享 UI，官方文档不承诺“保存到下载/Files”；Android 分享面板是否出现“保存到下载/Drive/Files”取决于用户安装的目标应用，不是系统保证。`design.md` 把 SAF 写成“可选增强”，意味着在只有系统应用、无云盘/Files 目标的常见 Android 设备上需求 2 无法完成 — 将 Android 保存改为正式路径：`expo-file-system/legacy` 的 `StorageAccessFramework.requestDirectoryPermissionsAsync` + `createFileAsync`（或 MediaStore/Downloads），把“下载并保存”和“分享”拆成两个动作；明确目标目录、重名覆盖、写入失败、取消和权限撤销行为，并在真机验证保存后的文件可被系统文件管理器打开。
- [BLOCKER] Android“用其它 App 打开”实际是分享，不是打开方式 — `expo-sharing` 在 Android 走 `ACTION_SEND` chooser，只列出接受分享的 App；PDF、压缩包等大量查看器注册的是 `ACTION_VIEW`，不会出现在分享面板。`design.md` 把 `expo-intent-launcher` 列为“后续可加”，等于需求 3 在 Android 上没有可靠实现 — 首期加入 `expo-intent-launcher`：用 `File.contentUri`（Expo 55 `expo-file-system` 已提供，Android）或 `getContentUriAsync` 生成 content URI，以 `ACTION_VIEW` + MIME + `FLAG_GRANT_READ_URI_PERMISSION` 启动；无可用 Activity 时回退到分享面板。iOS 侧同时补 `UTI` 和 iPad `anchor`；为两条路径分别写设备用例。
- [MAJOR] 现有二进制行是 `disabled`，长按动作根本不会触发 — `mobile/src/files/mobile-file-explorer-row.tsx` 对不可预览二进制行设置 `disabled={disabled}`，`Pressable` 被禁用后 `onLongPress` 不生效。设计/原型却要求 PDF、zip 等“不可预览但可下载/打开”，而 `tasks.md` 的 FB-U1 没有拆开“预览不可用”和“整行禁用” — 将 `previewDisabled` 与 `rowDisabled` 分离：行保持可聚焦、可长按，仅隐藏“预览”；仅在既不可预览也无任何动作时才真正禁用。同步改 `accessibilityLabel`/`accessibilityState` 和回归测试。
- [MAJOR] `FileActionTarget` 无法表达终端产物，导致 B8/B9 与预览页菜单无落点 — 设计 3.1 的 target 只有 `worktreeId`/`relativePath`，但终端产物路由使用 `source: 'terminalArtifact'` + `absolutePath` + `grantId`（`mobile/src/files/mobile-file-preview-route.ts`），且 `files.stat`/`files.readChunk` 不接受终端产物路径。设计 3.3 又要求终端产物“仅支持整文件读取”、超阈值提示，但任务表没有 grant 刷新、大小判定、图片 base64 落盘或路径复制的实现任务 — 把 target 改成可辨识来源的联合类型（worktree / terminal artifact），携带 `absolutePath`、`grantId`、展示用路径、已知大小；为 grant 过期刷新、文本 512 KB 截断、图片上限、超阈值和“复制路径”语义单列任务与测试。
- [MAJOR] OTA/web-shell 的路由决策仍未决，且被写成开发依赖 — 设计推荐“强制 native”，但 `shell-switch-decision.ts` 当前是在调用点决定是否传 route；任务 FB-U7 的依赖写作“评审决策”，不是可执行前置条件。若保留 web-shell，`expo-sharing`/SAF/Intent 在 WebView 页面不可用；若强制 native，OTA 构建会失去桌面文件页的其它能力（设计自己也未列出这些能力） — 在本次 G3 前由产品/技术确认并落成明确规则（文件浏览与预览路由恒 native，或 web-shell 内提供能力探测与降级提示），更新调用点、shell 测试和 OTA 真机用例，避免开发期再改架构。
- [MAJOR] 无“无权限”状态的数据来源 — 原型 05 展示 `.env` 行“无访问权限”，但 `files.readDir` 的目录项没有权限字段，现有 `FileExplorerRow` 只有 text/binary/directory/loading/error。设计正文也没有定义如何判定“无权限”，测试计划没有对应用例 — 明确该状态来自目录读取失败、stat/read 失败还是主机返回的错误码；若无法区分，删掉该状态或改为“读取失败”并在行内提供重试，避免实现出无法复现的 UI。

### 搜索与过滤

- [MAJOR] 搜索 `limit` 与 RPC 契约冲突 — `FilePathSearch.limit` 的 schema 是 `.max(32)`（`src/shared/rpc-contract/files-params.ts`），设计写“limit 30–50”；一旦按 50 发送会被参数校验拒绝 — 首期固定为 ≤32，或在设计/任务中显式新增可支持更大 limit 的 RPC（并做 paired client/host 兼容）。同时把“结果数上限”写进 UI 文案和测试。
- [MAJOR] 服务端结果截断没有被读取和呈现 — `searchMobileFilePaths` 的 inventory 上限是 `MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT = 20_000`，并返回 `totalCount`/`truncated`（`src/main/runtime/runtime-file-commands-constructor.ts`），但移动端复用的 `workspaceFilePathsSchema` 只取 `files[].relativePath`（`mobile/src/session/session-read-reply-schema.ts`），两个字段被丢弃。大仓库中用户会以为“没有这个文件” — 新写 search reader 读取 `totalCount`/`truncated`，在结果头显示“共 N 个匹配 / 仅显示前 32 个”或“文件库超过 2 万，结果可能不完整”；增加 >20k 文件和 >32 匹配的测试。
- [MAJOR] 先取 top-N 再客户端过滤会漏结果 — 设计 3.5 让过滤同时作用于树和搜索结果，但 `files.searchPaths` 没有类型参数；先由服务端返回最多 32 条，再按 chip 过滤，可能在“文档”chip 下只显示 1–2 条，而实际匹配的文档在 32 条之外。设计没有分页或“继续加载” — 明确组合策略：服务端只返回结果、过滤前显示“受上限限制”，或增加分页/更大结果集；至少不要给用户“已过滤全部”的错觉，并写测试。
- [MAJOR] 原型中过滤会把目录行隐藏、子文件悬空 — `file-actions.html` 的 `applyFilter` 按 `data-kind` 直接隐藏行；选择“代码”时 `src/components/files` 等 folder 行被隐藏，但其下深度为 2 的文件仍显示，树层级断裂 — 设计需要定义过滤后的目录可见性：保留匹配文件的祖先目录、折叠空目录、显示每类计数；修正原型并用嵌套目录验证。该缺陷会直接误导实现者按“逐行隐藏”写 FlatList 过滤。
- [MINOR] 旧主机回退弱于现有能力 — 现有 `use-mobile-native-chat-file-search.ts` 在 `method_not_found` 时通过 `files.list` 拉全量清单再搜索，而本设计只回退“已加载目录”，未展开目录完全搜不到。建议复用/泛化现有 hook 的 inventory 回退，而不是新写一个更弱的实现（也符合 AGENTS.md 的复用要求）。
- [MINOR] 排序/匹配语义与文案不一致 — 服务端 `rankRuntimeMobileFilePaths` 同时匹配完整相对路径和 basename，设计/原型文案是“按文件名搜索/按名称匹配”；需要明确是否接受路径匹配，并在结果中高亮匹配片段（原型已有 `<mark>`，设计正文和 tasks 没有对应任务）。

### 长按选中复制

- [MAJOR] HTML 渲染视图的文字选择被推到 P2，未获用户确认 — 需求 1 是“文件浏览支持长按选中复制文字”；同批 HTML 打开方式需求会把文件浏览器里的 HTML 变成可渲染 WebView（当前文件浏览器 HTML 仅源码）。若两者都交付，用户在渲染视图长按无法选中复制，只有“复制源码”兜底。这是显式的需求缺口，不是纯增强 — 要么在 `MobileHtmlPreview` 打开时启用 WebView `textInteractionEnabled`/对应 CSS 并处理链接点击冲突，要么由用户明确同意“HTML 渲染视图不支持文字选择”。同时补文件预览的选择态原型和 CJK/emoji 复制用例。
- [MAJOR] 选择复制只有入口没有状态原型 — G2 要求覆盖“预览选区菜单”；`file-actions.html` 只有“可选中复制”的静态说明，没有任何文本选区、原生选择菜单或“已复制”状态。设计把实现押在现有 `<Text selectable>` 上，但 Markdown 的 `rangeSelectable` 还涉及 `INLINE_TEXT_SELECTION` 在 Android 的不同处理（`mobile/src/components/inline-text-selection.ts`），没有原型很难判断链接/代码块/表格与长按选择是否冲突 — 增加代码、Markdown、HTML 源码三种选区原型（含 CJK/emoji、选区手柄、复制结果），并在设计里写明 Android/iOS 行为差异。
- [MINOR] 长按可发现性和反馈不足 — 设计正文没有规定提示条、行尾操作入口或长按震动；原型只有一行“长按”标签和一条 hintbar。长按是文件操作唯一入口，新用户不易发现，且现有应用在长按场景普遍使用 `triggerMediumImpact`。建议在文件页保留轻量提示或行尾“…”入口，长按触发 `haptics.triggerMediumImpact()`，并写入 tasks。

### 下载/打开交互

- [MAJOR] 动作可用性矩阵不完整 — 设计只列出了大致规则，原型只演示 text/binary/directory；图片、音视频、HTML、PDF、终端产物、无权限/旧主机分别显示哪些动作、禁用还是隐藏，没有逐项矩阵。尤其“复制文件内容”的 512 KB 截断提示、“打开方式”是否先下载、预览页“当前：预览”是否禁用，都缺定义 — 在 design.md 增加“文件类型 × 动作 × 状态”的表，原型补图片/媒体/PDF/终端产物四个 sheet 状态，并让任务 FB-T2/FB-Q1 直接引用该表。
- [MAJOR] 从预览页发起的下载/打开没有进度承载 — 组件树把 `MobileFileDownloadProgress` 放在 `MobileFileExplorerPanel`，但预览页头部菜单也会触发下载/打开；`ActionSheetModal` 关闭后预览页没有任何进度、取消或失败横幅。测试 C4 只写“禁用或等待”，没有定义 UI — 把“准备文件（下载到 cache）”做成统一状态机与单飞（同一目标只允许一个准备任务），预览页和文件页共用进度/取消/重试 UI；分享面板关闭、无可用 App、写入失败都要有明确落点。
- [MAJOR] 重试语义不可测 — 测试 B6 写“重试可继续或明确从头开始”，设计没有决定是否支持断点续传；分块 RPC 没有服务端 session 语义 — 首期明确“重试从头开始并删除临时文件”，或设计续传协议；把 `size/mtime/ctime` 校验失败、网络断开、应用后台/杀进程三种情况分别写成可断言用例。
- [MINOR] “下载到手机”和“用其它 App 打开”在 iOS/Android 上都会先落到分享面板，两个菜单项结果近似 — 用户会困惑为什么两个动作打开同一个系统面板。按 BLOCKER 1/2 拆分后，建议文案改为“保存到手机/文件”与“打开方式/分享”，并在原型中体现两个不同面板。

### 安全、缓存与隐私

- [MAJOR] 临时文件生命周期和清理策略不可执行 — 设计只写“按需清理”“保留到分享结束”；`expo-sharing` 的 Promise 在系统面板关闭时即返回，但目标 App 可能在返回后异步读取 content URI，立即删除会拿到空文件；同时 256 MB 文件长期留在 cache 既占空间也留下远端源码副本 — 定义明确策略：每次下载使用独立子目录 + 唯一文件名；分享后延迟清理（或保留到下次启动/LRU 配额）；应用启动和退出时清理孤儿；设置可见的“清除下载缓存”；测试分享取消、目标 App 延迟读取、应用被杀、重复下载和缓存上限。
- [MINOR] 文件名安全化/碰撞/边界没有定义完整 — 设计只说去除 `/`、`..`、控制字符；还需处理 0 字节、无扩展名、点文件（`.env`、`.gitignore`）、超长名（>255 字节）、Unicode 双向控制符、同名文件（不同目录都叫 `index.ts`）以及 cache 文件名与分享显示名分离。建议纯函数 `safeLocalFileName()` + 每次下载唯一目录，并补单测；0 字节文件不能复用 `downloadMobileFileMedia` 的 `size === 0` 拒绝分支（`mobile/src/files/mobile-file-media-download.ts` 会直接报 “no playable media”）。
- [MINOR] MIME/UTI 映射不完整 — 只按扩展名映射到 MIME，未知类型用 `application/octet-stream`；iOS 的 `UTI`（必要时 `anchor`）未提，代码文件（`.tsx`/`.ts`）用 octet-stream 可能没有目标 App 能打开。建议建立统一表：MIME、iOS UTI、代码/纯文本回退（`text/plain`）、图片/PDF/音视频精确类型；未知类型仍保持 octet-stream，并在 UI 说明“可能没有可打开的应用”。

### 测试与任务

- [MAJOR] 测试计划没有 AC→用例映射，且有平台/边界空洞 — G1 要求“每条验收标准的用例编号”，当前只有 A–E 分组；iOS 被标为“如不可用则记录未覆盖”，但环境是 macOS，分享面板/“存储到文件”必须用模拟器覆盖；缺少旧主机无 `files.stat`/`files.readChunk` 的下载降级、路径穿越/符号链接/控制字符、0 字节/无扩展名/点文件/超长文件名、搜索乱序响应与 20k 截断、无障碍、下载内容哈希校验、目标 App 实际打开（而非仅出现面板）等用例 — 增加 AC1–AC6 到用例 ID 的矩阵，补上述边界和平台用例；B7/C2 必须验证“保存后文件内容哈希一致”和“目标 App 实际打开”，不能只验证面板出现。
- [MAJOR] 任务拆分缺少原生配置/发布与质量任务，也没有风险/回滚点 — 缺少：Android SAF/MediaStore、ACTION_VIEW + content URI/FileProvider 校验、iOS UTI/iPad anchor、缓存清理、无障碍动作、旧主机下载降级、终端产物 grant 刷新、搜索截断 reader、原生模块重建后的版本号/发布验证。`tasks.md` 没有 G1 要求的“风险与回滚点”章节；FB-T1 说“更新 app config/prebuild”，但 `expo-sharing` 通常不需要 app.json plugin，真正需要的是 `pnpm install` + prebuild/新二进制 + 商店版本号 — 补齐上述任务，增加风险表和回滚方案（例如下载/分享上线后可通过远端开关退回“仅复制路径”）。
- [MAJOR] 跨需求共享菜单的依赖没有登记 — HTML 打开方式任务的 HT-U4 直接复用/修改 `MobileFileActionSheet.tsx`，但 HT 任务只依赖 HT-U1，没有依赖本需求的 FB-T2/FB-U2/FB-T4；本需求也没有为“HTML 追加动作”预留扩展接口。两个子代理并行开发会各写一套菜单或互相覆盖 — 在 tasks.md 明确 `MobileFileActionSheet` 与 `share-file.ts` 由本需求提供，HTML 需求依赖它们；定义 actions 的可扩展输入（额外动作、排序、可见性），并让预览页头部同时容纳 HTML 的“预览/源码”切换与本需求的溢出菜单。
- [MINOR] 任务依赖和覆盖有小问题 — FB-T3 依赖 FB-T1 不成立（下载只用已安装的 `expo-file-system`，只有分享需要 `expo-sharing`）；FB-Q2 声称覆盖搜索/过滤组件，却只依赖 FB-U1..U6，未依赖 FB-S2/S3/S5；FB-Q5 回归依赖“全部”但没有列出搜索结果/菜单回归。修正依赖并给每个任务附“测试文件/测试名”。
- [MINOR] 设计文档缺 G1 要求的显式用户流程和“备选方案与取舍”章节 — 现有内容把取舍散落在 3.3/3.6，评审无法一眼确认“为什么不用 HTTP 下载 URL / 不用桌面端中转 / 不先做 SAF”。补一节用户流程（列表长按、预览菜单、搜索、下载、打开、失败/取消）和一节备选方案对比，降低后续实现漂移。

### UI 原型

- [MINOR] 原型视觉与真实移动端主题不一致，且弹层形态自相矛盾 — 原型使用 `#05070a`/`#5b9dff` 等独立色板和 10–14px 圆角，实际 `mobile/src/theme/mobile-theme.ts` 是 `#111111`/`#3b82f6`/6px 圆角；实现必须回到 theme token，因此原型不能作为像素依据。`index.html` 声称“所有弹层为底部 ActionSheet”，但 `file-actions.html` 状态 04 用右上角 popover；移动端也没有现成 popover primitive。建议原型改为底部 ActionSheet（或明确新增可复用的 anchored menu 组件），并标注“颜色/圆角以 mobile-theme 为准”。
- [MINOR] 原型包含不可实现的交互和无效控件 — 文件行“点击”在原型中打开 ActionSheet，而设计是点击进入预览；文件树头部“更多”按钮没有绑定任何动作，设计也未定义该入口。建议原型点击行为与设计一致（长按才打开菜单），删除或定义头部“更多”，避免评审者和实现者误判。
- [MINOR] 原型无障碍尺寸与文案不一致 — 原型宣称 44×44 最小触控目标，但过滤 chip 高 32px、搜索清空按钮 28×28；另外原型 UI 全中文，而现有移动端界面文案为英文，未说明是否引入本地化。建议 chip/清空按钮使用 44px 触控区（或 hitSlop），并明确本期 UI 语言；若沿用英文，所有标签按现有应用文案重写。

## Requirement coverage

| 用户需求               | 覆盖情况                                                                                                                                                                                                                              | 结论                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1. 长按选中复制文字    | 文本/代码已有 `<Text selectable>`；Markdown 计划传 `rangeSelectable`；HTML 源码可复制；HTML **渲染视图**明确推迟到 P2；没有文件预览的选择态原型；终端产物文本可沿用同一路径                                                           | **部分覆盖，需确认 HTML 渲染视图范围并补原型/测试** |
| 2. 下载/保存到手机     | Worktree 文件用 `files.stat` + `files.readChunk` + cache 分块方案可行，复用 `mobile-file-media-download.ts` 的 size/mtime 校验；但 Android 没有可靠保存落点（分享面板不等同保存），终端产物只能整文件读取，缓存清理/0 字节/权限未定义 | **Android 不成立，整体不通过**                      |
| 3. 用手机 App 打开文件 | iOS 分享面板可覆盖“存储到文件”和部分打开方式；Android 用 `expo-sharing` 只有 `ACTION_SEND`，不是 `ACTION_VIEW`；MIME/UTI、iPad anchor、无可用 App、下载未完成状态未定义                                                               | **Android 不成立，整体不通过**                      |
| 4. 过滤查找文件        | `files.searchPaths` 已对移动端开放，可搜索未展开目录；类型 chips 可由扩展名实现；但 limit 上限 32、20k 截断未呈现、top-N 后再过滤会漏结果、旧主机回退弱、无分页/计数                                                                  | **部分覆盖，需修正契约和结果语义**                  |

## 待确认问题

1. “下载/保存到手机”是否接受“交给系统分享面板，由用户选择 Files/Drive”作为验收？如果不接受（Android 无保证），请确认本期加入 SAF/MediaStore 保存路径。
2. “用其它 App 打开”是否要求 Android 真正的 `ACTION_VIEW` 打开方式（推荐），还是接受分享面板？若接受后者，需求文案和验收标准应改成“分享到其它 App”。
3. HTML 渲染视图是否属于“长按选中复制文字”的验收范围？如果属于，P2 推迟需要用户明确批准；如果不属于，请在设计非目标中写明。
4. OTA/hybrid-shell 构建是否接受文件浏览/预览强制走 native？放弃桌面 web 文件页的哪些能力是可接受的？旧二进制（无 `expo-sharing`/SAF 代码）如何降级？
5. 终端产物本期是否支持“下载到手机”？若支持，10 MB 阈值、文本 512 KB 截断、图片 base64、grant 过期刷新分别怎么处理；若不支持，B8/B9 用例应删除或改为“仅复制路径/内容”。
6. 搜索结果是“按文件名”还是“按相对路径”匹配？是否需要结果高亮、总数和分页？“只显示前 32 条/文件库超过 2 万”能否作为可接受的产品限制？
7. 过滤 chip 的分类表由谁定义（代码/文档/图片/其它），点文件、无扩展名、`.svg`、音视频、PDF 分别归到哪一类？过滤后目录行是否保留？
8. 本期 UI 文案使用中文还是英文？原型全中文与现有应用英文文案不一致。
9. iOS 真机/模拟器是否必须覆盖？当前测试计划允许“记录未覆盖”，但本需求在 iOS 上的保存/打开方式与 Android 完全不同，建议至少以 iOS 模拟器作为 G6 必过项。
10. 下载缓存的保留时长和清理入口是什么？是否接受应用重启后清理，还是需要设置页的“清除下载缓存”？
