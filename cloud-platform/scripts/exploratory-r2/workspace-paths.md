# U46 内嵌简易工作区 · 探索路径（r2）

> 用途：把 r2 探索的入口序列、每类标签的操作步骤、边界样本和断言要点固化，后续回归可按「入口 → 步骤 → 检查点」重放。
> 证据：`cloud-platform/evidence/exploratory-r2/workspace.json`（findings/checks/screenshots）。本文只写路径，不写结论。
> 环境：平台 `https://127.0.0.1:18787/`；admin `admin / Adm1n!`，viewer `lisi / Passw0rd!`；宿主 `dev-local-02`（demo-app）与 `dev-local-03`（infra-tools）。

## 0. 可执行入口

```bash
# 主功能路径（标签/编辑器/md/预览/git/文件树/终端/登出）
node cloud-platform/scripts/exploratory-r2/run-workspace-exploration.mjs

# 生命周期 / 跨主机 / 权限降级 / 快速连点
node cloud-platform/scripts/exploratory-r2/run-lifecycle-crosshost.mjs

# 定点探针（结论证据）
node cloud-platform/scripts/exploratory-r2/probe-reentry-evidence.mjs   # 二次打开 NOT_SIGNED_IN
node cloud-platform/scripts/exploratory-r2/probe-binary-write.mjs       # 二进制可编辑且写回
node cloud-platform/scripts/exploratory-r2/probe-large-image.mjs        # 3000x2000 大图
node cloud-platform/scripts/exploratory-r2/probe-dirty-close.mjs        # dirty 关闭三选
node cloud-platform/scripts/exploratory-r2/probe-crosshost-race.mjs     # 关闭后二开/跨主机
```

隔离浏览器：Playwright Chromium `headless: true`，新 context，`ignoreHTTPSErrors: true`（中继边缘 `100.67.197.59:18444` 为本地自签证书）。不使用共享 MCP 浏览器，避免并发污染。

## 1. 测试数据（test fixtures，非产品代码）

写入 demo-app 的 admin checkout（`host/projects/demo-app/.orca-worktrees/admin/main-2/docs/`），保持未跟踪：

| 样本                                  | 用途                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `r2-fixtures/r2-markdown.md`          | 标题/列表/表格/代码块/链接/任务/katex/details + XSS（script/iframe/onerror/javascript:） |
| `r2-fixtures/r2-sample.html`          | `sandbox=""` 脚本阻断、onerror 阻断、源码切换                                            |
| `r2-fixtures/r2-sample.{png,jpg,svg}` | 图片 data URL                                                                            |
| `r2-fixtures/r2-large-image.png`      | 3000x2000 大图（108KB）                                                                  |
| `r2-fixtures/r2-sample.pdf`           | PDF 占位                                                                                 |
| `r2-fixtures/r2-sample.drawio`        | drawio 降级为源码                                                                        |
| `r2-fixtures/r2-binary.bin`           | 二进制（NUL/高位字节）误开样本                                                           |
| `r2-fixtures/r2-binary-copy.bin`      | 二进制写回证据副本（由原始复制）                                                         |
| `r2-fixtures/r2-large.txt`            | 760KB 截断只读样本                                                                       |
| `r2-fixtures/r2-empty.txt`            | 0 字节文件                                                                               |
| `r2-fixtures/r2 中文 & 空格.txt`      | 中文/空格/& 过滤                                                                         |
| `r2-fixtures/r2-<112 x>.txt`          | 超长文件名                                                                               |
| `r2-deep/a/b/c/d-e.txt`               | 5 层深目录                                                                               |
| `r2-empty/`                           | 空目录                                                                                   |

跨主机样本：`host2/projects/infra-tools/.orca-worktrees/admin/main-3/docs/runbook.md`。

## 2. 路径清单

每条格式：**入口 → 步骤 → 检查点**。选择器均为工作区 iframe 内的 `data-testid`；父页面用 `#workspaceOverlay`。

### P1 首次打开 / ready

入口：工作台行「打开」。
步骤：登录 admin → 点 demo-app 行「打开」 → 等 `#workspaceOverlay iframe` → 轮询 `[data-workspace-status]` hidden 或 `[data-workspace-ready-failure]`。
检查点：1 次 `POST /v1/projects/:id/web-handoff`，body `{"surface":"admin"}`；iframe 为 `cloud-admin.html?...embed=1&project=...`；兑换后 hash 无 `handoff=`；路线 badge 出现（`直连|中继`）；零 `window.open`。

### P2 外壳 / 状态栏

步骤：读 `cloud-simple-workspace` body。
检查点：无左栏；`+ 终端`、文件/Git 变更双 tab；状态栏含项目名、`E2EE`、路线、分支、`.orca-worktrees` 路径；空态文案「从右侧文件树打开文件，或新建终端」。

### P3 文件树

入口：右侧「文件」tab。
步骤：根展开 docs/src → 展开深目录 → 过滤输入 `r2` / `中文` / `<img src=x onerror=...>` / 无匹配 → 清除 → 刷新。
检查点：根含 docs/src/README.md 且无 `.git`；过滤命中已加载目录；中文与 `&` 名称命中；无匹配显示「没有匹配的文件」；过滤串不生成 DOM；清除恢复树；`docs/r2-empty` 显示「空目录」；刷新后 `aria-expanded=true` 的层级保留（docs/r2-deep/a/b/c/r2-fixtures/src）。

### P4 编辑器打开 / 去重 / 着色

步骤：点 `README.md` → 再点一次 → 点 `src/order.js`、`src/server.js`、`docs/design.md`。
检查点：tab id `file:<path>`；重复点同路径 tab 数不增；Monaco `.view-lines span.mtk*` 有 token 颜色、行号存在；header 显示相对路径。

### P5 编辑 / dirty / 保存

步骤：Monaco 末尾输入 `\nr2-edit-<ts>` → 读 dirty 标记 → 点 `cloud-workspace-file-tab-save`。
检查点：tab 的 `cloud-simple-workspace-tab-dirty-file:README.md` 出现；状态栏 `● 未保存 N`；父覆盖层 `[data-workspace-dirty]` 显示「N 个未保存文件」；保存后 dirty 清空、磁盘 README 含 marker；保存按钮在 clean 时 disabled。

### P6 冲突

步骤：编辑 README → 宿主侧追加 `r2-external-change` → 保存。
检查点：`cloud-workspace-file-tab-conflict` 出现「重新加载 / 覆盖保存 / 取消」；取消保留 tab 与 buffer；再次保存 → 重新加载后编辑器出现 external 内容。

### P7 截断 / 空文件

步骤：打开 `r2-large.txt`、`r2-empty.txt`。
检查点：大文件 `cloud-workspace-file-tab-readonly`=「只读」、notice 含「截断」、无保存按钮；空文件正常进编辑器、无报错。

### P8 Markdown 双模式 / XSS

步骤：打开 `r2-markdown.md` → 点 `cloud-workspace-file-tab-mode-preview` → 点 `mode-edit`。
检查点：渲染 h1/h2/表格/代码/链接 `target=_blank`/katex `.katex`/details；DOM 中 `script/iframe/[onerror]/javascript:` 均为 0；`window.__r2Xss` 未置位；切回编辑看到 Monaco 源码。

### P9 图片预览

步骤：依次打开 `r2-sample.png`、`r2-sample.jpg`、`r2-sample.svg`、`r2-large-image.png`。
检查点：`cloud-workspace-preview-image` 的 `src` 以 `data:image/` 开头；`naturalWidth>0`；badge「图片」；大图 3000x2000 在 ~0.3s 完成。

### P10 HTML 沙箱 / 源码

步骤：打开 `r2-sample.html` → 读 `cloud-workspace-preview-html-frame` → 切 `preview-mode-source`。
检查点：`sandbox=""`、`referrerpolicy=no-referrer`；srcdoc 正文可见；`data-script-ran`/`data-img-error` 均未设置；源码视图含 `<script>` 原文。

### P11 PDF / drawio

步骤：打开 `r2-sample.pdf`、`r2-sample.drawio`。
检查点：PDF 显示「PDF 预览不在简易版范围」；drawio 显示「不加载第三方脚本」+ `r2-sample.drawio` 源码。

### P12 二进制（finding 路径）

步骤：打开 `r2-binary.bin`。
检查点（按规格）：应为二进制占位、不可编辑。实际断言：tab 类型、`cloud-workspace-preview-binary` 是否存在、编辑器/保存按钮/只读 badge 状态。

### P13 Git 面板

步骤：点「Git 变更」→ 读分组与提交 → 展开最新提交 → 点提交文件 → 切左右/合并 → 文件 tab 编辑保存 README → 刷新 Git → 点修改行 → 点 untracked 的 `r2-binary.bin`。
检查点：分组与 `git status --porcelain --untracked-files=all` 一致（本环境 13 个未跟踪）；提交数 = `git rev-list --count HEAD`（本环境 main-3/main-2 为 4）；提交文件懒加载；diff source badge「提交 <sha>」/「工作区」；左右/合并 `aria-pressed` 翻转；二进制 diff 显示 `cloud-workspace-diff-binary`。

### P14 多标签混合 / 去重 / 关闭邻接

步骤：保持终端 + editor + preview + diff → 激活中间 tab → 点其关闭。
检查点：一条标签条含 `terminal-*`、`file:*`、`preview:*`、`diff:*`；关闭激活 tab 后激活右邻（无则左邻）；同文件 editor/preview 共槽；最后关闭显示空态。

### P15 终端 echo / 上限

步骤：`+ 终端` → 等 `cloud-terminal-state` 含「实时」→ 点 `.xterm-screen` → 输入 `touch <worktree>/docs/r2-terminal-marker` + Enter → 连点 `+ 终端` 至 6。
检查点：marker 文件在宿主出现；6 个 terminal tab；`+ 终端` disabled，title「最多 6 个终端」；关闭一个后恢复可用。

### P16 dirty 关闭三选

步骤：打开/编辑 `docs/design.md` → 点 tab 关闭 → 取消 → 再关闭 → 放弃 → 再打开编辑 → 关闭 → 保存。
检查点：`cloud-simple-workspace-close-confirm` 含「保存/放弃/取消」；取消保留 tab+buffer；放弃关 tab 不落盘；保存落盘后关 tab。

### P17 登出清理

步骤：覆盖层开着 → 程序化点击 `#logoutBtn`。
检查点：覆盖层移除、登录表单出现；iframe 收到 `logout` 后 signOut；平台登录页显示。

### P18 关闭握手 / 覆盖层 dirty 确认

步骤：编辑 README 使父覆盖层 dirty>0 → 点顶栏关闭 → 接受原生 confirm。
检查点：dialog 文案含「有 1 个文件未保存，确定关闭工作区？」；覆盖层移除（≤300ms 兜底 + 握手）；底层工作台路由不变；重新打开为空 tab 集（当前版本受 P19 影响）。

### P19 二次打开（finding 路径）

步骤：首次打开 demo-app（ready）→ 关闭 → 同一浏览器 profile 再点「打开」（同项目或 infra-tools）。
检查点：应再次 ready；实际观测 iframe 内「工作区打开失败（NOT_SIGNED_IN）」、父层 20s 后「工作区加载超时…当前宿主可能不支持内嵌工作区」；重试仍失败；「在新标签打开 Orca Web」可用。清除边缘 origin 的 site data 可恢复首次打开。

### P20 失败态 / 重试 / 新标签退路

步骤：制造 P19 失败 → 点 `[data-workspace-retry]` → 再失败 → 点失败框内「在新标签打开 Orca Web」。
检查点：失败态含重试与退路；retry 重新签发 handoff 并重建 iframe；新标签打开 `web-index.html` handoff 页。

### P21 跨主机首开（dev-local-03）

入口：工作台 infra-tools 行「打开」。
步骤：等 ready → 读状态栏 → 打开 `docs/runbook.md` → 新建终端 → `touch` host2 worktree marker。
检查点：ready；状态栏含 `infra-tools`、`host2`、`main-3`；编辑器路径 `docs/runbook.md`；marker 在 host2 出现；branch 非空。

### P22 只读降级（lisi）

入口：lisi 登录 → demo-app「打开」。
检查点（按规格）：应出现「未授予终端权限，无法创建工作区」的明确降级页；实际 iframe 内为「工作区打开失败（forbidden）」，父层 9s 仍显示「正在进入项目工作区…」。

### P23 快速连点

步骤：同一 tick 对行内「打开」按钮 `click()` ×5。
检查点：1 个覆盖层、1 个 iframe、最终 ready；记录 `POST /web-handoff` 次数（本环境 5 次，4 个一次性码未使用）。

### P24 全链路回归顺序建议

1. `pnpm build:web-from-renderer`（宿主从 `out/web` 伺服 cloud-admin，不重建会拿到旧 bundle）
2. 启动/重灌本地环境（reseed）
3. 先跑 P1–P18（功能面），再跑 P21（首开跨主机），最后跑 P19/P20/P23（会把 iframe origin 写脏，故放最后）
4. 每次运行使用新 context；P19 需要同一 profile 内的第二次进入
5. P22 需要新 context + lisi

## 3. 断言技巧

- 所有 iframe 内查询用 `:visible`：非激活 tab 的 pane 保持挂载（`hidden`），同 testid 会重复。
- 文本优先：状态栏/dirty/tab 标题/Git 分组/提交行/diff badge 全部用 `innerText` 断言；截图只补布局证据。
- dirty 关闭确认是 React 自定义 dialog（`cloud-simple-workspace-close-confirm`）；覆盖层 dirty 关闭是原生 `window.confirm`，Playwright 需注册 `page.on('dialog')` 并 accept。
- 终端在 `cloud-terminal-state` 显示「实时」前输入会丢键；先等文本再点 `.xterm-screen`。
- Monaco 写入：点 `.monaco-editor:visible .view-lines` → `Meta/Ctrl+End` → `keyboard.type`；不要依赖 `__monacoEditorE2E`（生产构建不安装）。
- 宿主证书自签：context 必须 `ignoreHTTPSErrors: true`；否则中继边缘 iframe 报 `ERR_CERT_AUTHORITY_INVALID`。
