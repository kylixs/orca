# 移动端 HTML 打开方式：测试方案

> 对应设计：`design.md`（第 8 节优先）
> 目标：证明 HTML 可在源码/渲染间切换，打开方式菜单在右菜单、长按、自动弹层三处一致，安全边界可验证，且不回归现有预览。

## 1. 环境

| 环境                    | 用途                                               |
| ----------------------- | -------------------------------------------------- |
| Vitest（mobile）        | 偏好、模式优先级、动作数组、检测纯函数、组件       |
| TypeScript / oxlint     | 静态检查                                           |
| Android 模拟器/真机     | WebView 渲染、导航、长按、SAF/打开（复用文件浏览） |
| iOS 模拟器/真机（必过） | 同上 + Save to Files/share                         |
| SSH / folder workspace  | `files.read` 路径一致                              |

## 2. AC → 用例

| AC                  | 用例                 |
| ------------------- | -------------------- |
| AC1 首次点击弹层    | A1..A3、A8           |
| AC2 渲染/源码切换   | A2/A3/B1/B8/A14/A15  |
| AC3 溢出/长按菜单   | B2/B3/B9/B11/B12/B13 |
| AC4 记住/恢复       | A4/A5/A9/A10/A11     |
| AC5 相对资源/大文件 | C2/C5/C8/C9          |
| AC6 外链/安全       | C3/C10/C11/C12       |
| AC7 回归            | R1..R8               |

## 3. 用例

### A. 模式与偏好

| ID  | 场景                                   | 预期                                                                                  |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| A1  | 首次点击 worktree HTML                 | 弹层只显示 Preview / Source（无 Orca、无 More）                                       |
| A2  | 选择 Preview                           | 渲染视图；第二行工具栏显示 Preview 选中                                               |
| A3  | 选择 Source                            | 源码视图；内容一致                                                                    |
| A4  | 记住 Preview                           | 后续直接渲染，不再弹层                                                                |
| A5  | 设置改回 Ask                           | 下次点击重新弹层                                                                      |
| A6  | 非 HTML 文件                           | 不受 HTML 偏好影响                                                                    |
| A7  | 无偏好键/损坏值                        | 回退 `ask`，不崩溃                                                                    |
| A8  | 自动弹层计数                           | worktree 固定两个模式；`line` 深链直接 Source；terminal artifact 直接 Source；不 stat |
| A9  | 外部动作/长按不记忆                    | Save/Open/Copy/长按选 Preview 均不写 `orca:mobileHtmlOpenMode`                        |
| A10 | 偏好写失败                             | toast；本次动作仍执行；偏好保持 Ask                                                   |
| A11 | 设置写入失败                           | 提示并回退原值                                                                        |
| A12 | 偏好=Preview + `line` 深链             | 进入 Source 并滚动到行（优先级见 design 8.4）                                         |
| A13 | route `mode=preview` + `line`          | route mode 优先（无 terminal/truncated）：进入 Preview（不滚动）；返回后不写偏好      |
| A14 | `source=terminalArtifact&mode=preview` | 强制 Source，无渲染 tab；可编辑仍 Save                                                |
| A15 | `mode=preview` + 513 KB                | 读取后切 Source + 截断横幅；不渲染                                                    |

### B. 菜单与切换

| ID  | 场景                                                | 预期                                                                                                                           |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B1  | 第二行 Preview/Source 切换                          | 即时切换，只有一个切换控件                                                                                                     |
| B2  | 预览页溢出 `…`                                      | 完整数组：Preview、Source、Save to phone、Open with、Copy content、Copy path、Cancel；只有一个 Preview；无 Orca/Ask            |
| B3  | 长按 HTML 文件行                                    | 与 B2 相同但无 remember 开关；Preview 是模式动作                                                                               |
| B6  | Open with                                           | Android ACTION_VIEW 选择器 / iOS share；取消返回                                                                               |
| B7  | Copy path                                           | 复制相对路径                                                                                                                   |
| B8  | 路由 `mode=source`                                  | 直接源码；无第二个切换控件                                                                                                     |
| B9  | 文件浏览 + HTML 动作合并（list/preview 两 context） | 两个数组都等于：Preview、Source、Save to phone、Open with、Copy content、Copy path、Cancel；只有一个 Preview；不可用项一致隐藏 |
| B10 | Copy content                                        | 读取 ≤512 KB；截断时复制部分并提示 “Copies the first 512 KB”                                                                   |
| B11 | 长按后释放                                          | 不触发预览；菜单只出现一次                                                                                                     |
| B12 | >512 KB（truncated）菜单                            | 数组：Source、Save to phone、Open with、Copy content（Copies the first 512 KB）、Copy path、Cancel；无 Preview                 |
| B13 | 读取失败菜单                                        | 数组：Retry、Save to phone、Open with、Copy path、Cancel；无 Preview/Source/Copy content                                       |

### C. 渲染与安全

| ID   | 场景                                | 预期                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | 自包含 HTML                         | 渲染；内联样式/脚本按 native 策略执行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| C2   | 相对 CSS/图片/JS                    | 顶部提示并列出最多 3 个检测引用；不崩溃                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| C3   | 页面内 http(s) 链接点击             | 调 `openExternalLink`；WebView 不原地跳转                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C4   | 脚本无限循环                        | App 不崩溃；可返回/退出预览；不要求超时                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| C5   | >512 KB                             | `truncated`：源码显示 “Showing first 512 KB”；Preview 禁用且 `accessibilityState.disabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C6   | 非 UTF-8 字节                       | 显示替换字符；不崩溃；无 `binary_file`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C7   | Web 端 iframe                       | sandbox 生效；不执行脚本；不能访问宿主                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C8   | 相对资源检测矩阵                    | `mailto:`/`tel:`/`javascript:`/`about:`/`blob:`/`//`/`#`/空 href/`http(s):`/`data:` 不提示；`./`、`../`、裸名、`/assets/x.css` 提示；空 HTML 不提示；iframe `srcdoc` 内的转义 `href`/`src` 内容不提示（不是顶层资源，且不得出现 `&quot;` 乱码）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| C9   | 512 KB 边界                         | 511/512 KB 不截断可渲染；513 KB/1 MB 截断且 Preview 禁用；源码文案 “Showing first 512 KB”；横幅 “File is larger than 512 KB. Rendering is unavailable; open the source or use desktop Orca.”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C10  | scheme 白名单                       | 顶层仅 http/https/mailto；file/intent/javascript/tel/自定义 scheme 拒绝；native toast “This link type isn't supported in preview”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C11a | iOS 危险链接                        | `file:`/`intent:`/`javascript:` 点击不拉起外部 App；http(s) 正常打开                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| C11b | Android 危险链接                    | 必须在真实 WebView 中点击（不能只调导航回调）；`javascript:` 不执行、无对话框，file/intent/自定义 scheme 不外开，均出现 toast；页面脚本在 window 捕获阶段 `stopPropagation`、预置可写 flag、以及预置精确值 `{value:'v2', writable:false, configurable:false}` 均不能绕过；http(s) 仍外开。原生 `shouldOverrideUrlLoading` 不覆盖点击的 `javascript:`/`file:`/`intent:`/`tel:`（设备实测），不得以原生回调兜底为断言。document-start 的保证下限为 WebView 89+；`onPageStarted` fallback（<89）为主帧 best-effort，不据此断言“不可绕过”                                                                                                                                                                                                                                                                       |
| C12  | 脚本 `location.href` / meta refresh | 脚本 `intent:`/自定义 scheme 由原生回调拒绝并 toast；脚本 `file:` 可能被 WebView 引擎静默拒绝（不导航；Android 实测无 toast，不要求 toast）；meta refresh 到 `file:`/`intent:` 不导航且出现 toast；动态插入的 0 延迟 blocked meta 在 MutationObserver 回调中同步移除（早于 50 ms debounce 与导航任务）；**先 append、后设置 `content`/`http-equiv` 的 blocked meta 同样在属性变更回调中移除；被移除节点再次 append 后仍被移除（WeakSet 只抑制重复 toast），50 ms 全量扫描兜底后节点仍不在 DOM**；`form.submit()` 不触发 submit 事件为已知残余；http(s) 可能外开（design 8.1 已知残余风险），不作失败断言                                                                                                                                                                                                    |
| C19  | 拦截通道安全                        | `onMessage` 只接受固定哨兵；URL/JSON/大小写变体/非字符串 payload 被忽略；不注入对象桥；fence 注入子帧但子帧消息不触发宿主动作（子帧 `javascript:` 不执行、无 toast）；宿主在 toast 可见时忽略重复哨兵；页面伪造哨兵最多产生 toast（design §9）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C13  | 渲染文字选择 + 链接                 | iOS 由 FB-U11 `textInteractionEnabled` 控制；Android 用 WebView 默认选择；长按选字不触发链接，点击链接仍外开                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C14  | 读取失败/0 字节/无可用 App          | 读取失败 Retry；0 字节空态；无 App toast “No app available for this file type. Use Save to phone instead.”。能力探测只看原生模块是否存在，不枚举 MIME handler，因此 Open with 不会在打开前隐藏；该 toast 仅在打开失败且无分享回退时出现。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C15  | CJK/emoji 内容与文件名              | 渲染/源码/复制正确                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| C16  | 返回/旋转                           | 模式按 page-local 规则；不崩溃                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C17  | 断线重连                            | 读取失败可重试成功；不崩溃                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C18  | iframe（iOS/Android）               | iframe 渲染且不拉起外部浏览器；导航型/`srcdoc` 子帧两端都注入 fence：`javascript:` 不执行；`intent:`/`file:`/自定义 scheme 不离开预览/不外开；子帧内仅 `http(s)`/`data:`/`about:srcdoc`/`about:blank`（可带 fragment）放行，`mailto:`/`tel:`/`blob:` 等与原生 `SUBFRAME_SCHEMES` 一致地阻止（不打开邮件/拨号/外部浏览器）；Android 回调经补丁传递 `request.isForMainFrame()`，子帧 https 仍在预览内渲染、子帧 mailto 不打开邮件 App；子帧哨兵被原生补丁丢弃，不显示 toast；web sandbox 不执行脚本。**动态 `about:blank` + `document.write` 帧**：同源父文档在插入时把 fence 安装到子窗口，点击 `javascript:` 不执行；跨源/CSP 禁止 eval 时为残余（不得声称所有 iframe 都经过 document-start 覆盖）；同一任务内先于 adoption 执行的内联脚本可注册抢占监听或篡改 `eval`，属已记录残余（另有固定该限制的测试） |

### D. 回归

| ID  | 场景                    | 预期                                                 |
| --- | ----------------------- | ---------------------------------------------------- |
| R1  | 会话 HTML 预览          | Preview/Source、链接行为不变                         |
| R2  | Markdown 预览/源码      | 不变；截断文案仍是 “Preview truncated. File size: …” |
| R3  | 文件浏览菜单            | HTML 用模式 Preview 取代通用 Preview；无重复         |
| R4  | 目录懒加载/搜索/过滤    | 不变                                                 |
| R5  | OTA/web shell           | 文件预览强制 native；mode 不丢                       |
| R6  | line/column 深链        | 默认 Source 并滚动到行                               |
| R7  | terminal artifact HTML  | 可编辑/只读均 source-only；可编辑 Save 不变          |
| R8  | `openExternalLink` 契约 | `orca://x` 等直通测试不变                            |

## 4. 测试数据

- 自包含、相对引用、外链、危险 scheme、meta refresh、iframe。
- 511/512/513 KB、1 MB、0 字节。
- 非 UTF-8 字节、CJK/emoji 文件名与内容。
- 偏好损坏值、写失败 mock。
- SSH 主机与 folder workspace 各一条。

## 5. 执行与证据

```bash
pnpm --dir mobile test
pnpm --dir mobile typecheck
pnpm --dir mobile lint
pnpm tc
```

- Android/iOS 各记录 WebView 版本、截图/录屏、菜单数组、导航结果。
- 证据归档到 `test-reports/`，逐条对应用例 ID。
