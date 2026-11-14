# W11 审计报告（原生壳常驻「登录云端平台」按钮 + 登录弹框）

- 审计人：独立审计代理（只读）
- 日期：2026-11-14
- 审计对象：提交 `a82aa84c082`（feat(cloud): login button and dialog on the native shell，13 文件 +595/−236）
- 对照基准：`requirements.md` FR-2.7（W11 形态修订）、`design-adjustment-native-ui.md` §4.2（登录入口形态 2026-11-14 修订 + 云端=附加渠道原则）、AGENTS.md / `docs/STYLEGUIDE.md`（ui 原语不可改、无裸色值、无计算 className、max-lines 纪律、命名/注释）
- 方法：只读 diff 逐文件审阅 + 源码交叉验证（main/preload/renderer 三层）+ 布局几何推算（与状态栏/通知/Toast 的叠放）+ 定向测试复跑 + 门禁复跑（oxlint / changed-code-quality / max-lines ratchet / localization extraction）。审计期间未修改任何源文件，仅新增本报告。

## 结论

**有条件通过**：blocker 0、major 2、minor 6、note 8。

主链路语义成立：全构建装配云端 IPC 且非云端构建不恢复会话（`restoreSession` 被 `isCloudPlatformBuild` 门住，结构上保证「不自动登录」）；signed-out 状态下所有 `cloud:*` handler 均短路（`NOT_SIGNED_IN` / `PLATFORM_ADDRESS_REQUIRED` / 空结果），除用户主动提交登录外启动零网络；密码只进登录请求体，不落盘、无日志；登录记忆文件读写实现未被触碰，仍只含地址+用户名；`CloudLoginForm` 抽取逐字搬运标记，管理员会话页全页登录零回归（7 例既有测试全绿）。全页接管（`CloudModeGate` 残留的登录页）按 W11 决策移除，属设计要求而非回归。

**两项 major**：① 常驻 chip `fixed bottom-3 right-3 z-40`（高 24px，距底 12–36px）与原生状态栏（in-flow，h-6=24px，默认可见，右端聚集悬浮终端开关、状态可见性菜单等交互控件，右内边距同为 12px）上半区直接重叠，且容器非 `pointer-events-none`——云端 UI 遮蔽原生入口，正面违反 §4.2b「任何云端功能不得移除或遮蔽原生入口」，W11 把原属云端构建的既有摆放推广到了**每一个构建的每一个状态**；同时该角落也是 sonner Toast（`position="bottom-right"`）的落点，Toast 活动期 chip 被整片盖住。② W11 的核心约束「原生 shell 全状态渲染、云端纯加法」在测试上不可变红：`App.cloud-mode-regression` 把 `AppWorkspaceShell` mock 成一个 `<div data-testid="workspace-shell"/>` 桩，断言只证明「shell 组件被挂载」，无法发现侧栏/添加项目/配对入口缺失，更无法发现遮蔽——M1 正是在这个盲区里发生的。

---

## 1. 设计原则符合性（重点）

### 1.1 原生 shell 全状态渲染、云端 UI 纯加法

**代码层（通过）**：

- `src/renderer/src/App.tsx:97-103` 未变：`CloudWorkspaceEntry` 只包住 shell 与 `AppRootSurfaces`；`cloud-workspace-entry.tsx:296-319` 现在无条件渲染 `{children}`，签出态不再整页替换为 `CloudLoginPanel`，`loading` 态的空白占位页也一并移除（原「云构建不得闪烁本地壳」的注释与实现同删）——这正是 W11 决策要求的形态反转。
- 13 个文件没有任何侧栏、标题栏、添加项目/配对入口的改动；renderer 中也不再存在以 `window.api.cloud` 存在性当「云构建开关」的判断（全仓只有 `cloud-workspace-entry.tsx:35` 一处取 bridge）。
- `popout.tsx` / `web-index.html` / `cloud-admin.html` 三个入口不经 `App.tsx`，chip 只出现在主窗口壳。

**布局层（不通过 → M1）**：

- chip：`cloud-login-entry.tsx:48` `fixed bottom-3 right-3 z-40 flex items-center gap-2`，内含 `Button size="xs"`（`h-6`=24px，`components/ui/button.tsx:23`）→ 实际占位距底 12–36px、宽约 110px（签入态更宽：账户名+登出+新建项目）。
- 状态栏：`StatusBarSurface.tsx:111` in-flow `h-6 min-h-[24px] … relative`，由 `AppRootSurfaces.tsx:176-192` 排在 `100dvh` 弹性列（`main.css:885-891`）末尾 → 占据视口底部 0–24px；默认可见（`ui-slice-hydration-actions.ts:176` `statusBarVisible ?? true`）。
- 右端控件：`StatusBarSurface.tsx:286-343` 右侧簇依次为 Caffeinate / 更新 / Pet / 资源 / 端口 / SSH / **悬浮终端开关（`size-5`，y≈2–22px）**，最后一项是 `StatusBarVisibilityMenu`；bar 右内边距 `px-3`=12px 与 chip 的 `right-3` 对齐 → 重叠区为状态栏上半 12px，恰好盖住最右侧 1–2 个原生交互控件的上半（含点击热区，chip 容器不是 `pointer-events-none`）。
- 同角冲突：`components/ui/sonner.tsx:17` `position="bottom-right"`（App.tsx:107 全局挂载），Toast 层级高于 z-40，出现即盖住 chip；反向看，`NotificationCardStack`（`bottom-10 right-4 z-40`）起于 40px，与 chip 相接不重叠。
- 定性：chip 摆放本身是 W10 既有（`cloud-workspace-banners.tsx` 旧 37 行同坐标），但 W10 只影响云构建签入态；W11 把它变成**全构建常驻**，与 §4.2b 明文冲突。建议改为状态栏内的一个原生 segment，或锚定到 `STATUS_BAR_RESERVE_HEIGHT` 之上。

### 1.2 非云端构建「不自动登录、零网络启动」（断言真实）

- `cloud-platform.ts:276-283`：`restoreSession()` 被 `isCloudPlatformBuild(env)` 门住；`isCloudPlatformBuild` 只看 env 地址/构建默认/托管开关，不读登录记忆 → 无 env 开发构建即使磁盘留有上次会话文件也不会恢复。
- `cloud-session-service.ts:126-136`：`whenRestored()` 在未启动恢复时立即 `Promise.resolve(this.state)` → 非云端构建的 `cloud:getState` 即时返回 signed-out，不会挂起渲染。
- 装配成本（无 env 构建）：`readCloudLoginMemory`（一次小文件读）+ `new CloudSessionService`（`cloud-session-service.ts:57-68` 与 `cloud-project-connections.ts:56-62` 构造均为惰性字段赋值，无定时器/无网络）+ 14 个 `ipcMain.handle` 注册。**零网络成立**。
- renderer 侧启动只调 `getLoginContext` + `getState`（`use-cloud-session.ts:157-186`，本地 IPC）；`useCloudWorkspaceEntry` 的准备流程仅在 signed-in 时触发（`cloud-workspace-entry.tsx:67-79`）。`App.cloud-mode-regression.test.tsx:63-91` 以 spy 断言 `login`/`registerProjects` 未被调用。
- 测试：`cloud-platform-login-gate.test.ts:146-157` 以 mock 计数器断言 `restoreCalls === 0` 且状态 signed-out，可变红。缺口见 m4（未覆盖「磁盘已有 saved session」的真实 dev 中间态）。

### 1.3 暴露门改全构建装配的安全影响

- **handler 无副作用成本复核（通过）**：signed-out + 无地址构建下逐通道核验——`state`（即时本地值）、`loginContext`（缓存）、`login`（`loginPlatformAddress` 先行，`cloud-platform-address.ts:72-94`：无地址→`PLATFORM_ADDRESS_REQUIRED`，非法→`PLATFORM_ADDRESS_INVALID`，均不触会话；`beginLogin` 还有第二道同码防线 `cloud-session-saved-login.ts:56-66`）、`listProjects`/`openProject`/`rpc`（client 为 null → `NOT_SIGNED_IN`，`cloud-session-service.ts:186-190/255-259/350-353`）、`registerProjects`/`retryPrepare`/`createProject`（显式 signed-in 守卫，`cloud-platform.ts:148-198`）、`archiveProject`（`NOT_SIGNED_IN`，service:218-224）、`listProvisionableHosts`（try/catch→[]）、`logout`/`closeProject`（仅本地 fs + 关连接）。唯一网络路径是用户主动输入合法地址后的 login——普通桌面用户误触登录失败的代价是一段内联错误文案（`cloud-login-panel.tsx:22-29` 已含 `PLATFORM_ADDRESS_REQUIRED/INVALID` 中文映射），无状态污染。
- **暴露面扩大（记录，不判违规）**：旧门之下桌面构建的 `cloud:*` 通道根本未注册，渲染进程被攻破也无法触达；现在常驻可调用。由于全部通道要求先登录，且登录需要凭据，实际增量是「被诱导向任意 https 地址提交域账号」的钓鱼面——这是 W11「全部构建均有入口、地址可手填」决策的固有属性（非托管构建不设地址白名单），建议后续考虑首用时提示或企业策略白名单。
- `setActiveCloudSession(session)` 现在每构建写入，但 `getActiveCloudSession` 无生产读者（全仓仅 fixtures 调用），惰性无害。

## 2. 安全

- **记忆文件边界不变（通过）**：本提交未触碰 `cloud-login-memory.ts`；`installCloudPlatformIpc` 只读它（`cloud-platform.ts:260`），写入仍只发生在登录成功的 `attach`（`cloud-session-saved-login.ts:88-101`），内容仅 `{lastPlatformUrl, lastUsername}`，走 `writeSecureJsonFile` + `hardenExistingSecureFile`。
- **托管只读（通过）**：UI 层 disabled + 说明文案（`cloud-login-panel.tsx:146-150` 区段）+ main 层忽略表单值（`loginPlatformAddress` locked 分支），三层一致；测试覆盖 UI（cloud-login-entry 例 5）与 IPC（gate 测试 242/256 行）。
- **登出顺序与失败中间态（顺序正确，失败路径有缺口 → m1）**：main 侧 `logout` handler 先 `removeCloudRuntimeEnvironments` 再 `session.logout()`（`cloud-platform.ts:89-96`，先退役环境再结束会话，符合「pane 不再能寻址」注释）；renderer 侧 `cloud-project-repos.ts:143-153` 先 `ports.signOut()`（main 登出）再 `purgeRepos`（摘侧栏行），`cloud-workspace-entry.tsx:291-294` 先 entry 再 session，测试用 `invocationCallOrder` 锁序（cloud-login-entry 例 6）。缺口：`cloud-login-entry.tsx:35-49` 的 `void (async () => { await onSignOut(); await session.signOut() })()` 无 catch——`bridge.logout()` 内的 fs 写或 `hydrateRuntimeEnvironmentStatuses()` 一旦 reject，`purgeRepos` 与 `session.signOut()` 都不执行（侧栏残留指向已退役环境的行、视图停在 signed-in），且 rejection 无人处理、无任何用户可见反馈，只能靠再点一次登出自救。
- **弹框密码处理（通过）**：`password` 仅存于 `CloudLoginForm` 局部 state，`onSignIn` 直通 IPC→`client.login` 请求体（`cloud-connect-client.ts:169-177`）；main 侧 `cloud-session-service.ts`/`cloud-auth-session.ts` 无任何 console 输出；弹框关闭不清空密码（state 保留在组件内，弹框卸载即丢弃），不落盘。
- **错误码跨 IPC 映射（通过，既有）**：main 以 `Error(message=code)` 抛出弥补 Electron 丢弃 `code` 属性，renderer `readIpcErrorMessage` 还原（`use-cloud-session.ts:228-237`），gate 测试 227 行锁定。

## 3. 契约

- **`CloudLoginForm` 抽取（零回归成立）**：`cloud-login-panel.tsx` 的拆分是把原 `<form>` 原子级搬入 `CloudLoginForm`，`CloudLoginPanel` 改为全页壳（70-88 行）+ 委托；壳的 class 串与拆除前逐字相同（`flex h-full w-full items-center justify-center bg-background` + 卡片容器），管理员会话页 `cloud-app.tsx:27` 调用点未改。既有 `cloud-login-panel.test.tsx` 7 例全部经由组合后的 `CloudLoginPanel` 执行（预填/晚到默认值/必填校验/内联地址校验/托管只读/错误码文案），复跑通过。保留缺口：壳的 class 本身无断言（既有，非本提交引入）。
- **`NewCloudProjectButton` 容器迁移（无断言 → m2）**：`cloud-workspace-banners.tsx:40-44` 去掉自带 `fixed bottom-3 right-3 z-40` 容器，改为由 `cloud-workspace-entry.tsx:311-315` 作为 `leading` 传入 entry 行。坐标/层级不变、仅多出同行兄弟（`gap-2`），静态审阅无视觉回归；但**全仓没有任何测试引用 `新建云端项目`/`leading` 槽位**，该「共享角落」的声明纯靠人眼。
- **preload 契约（收窄 → m3）**：`cloud-platform-exposure.test.ts` 修订后只剩 `login` invoke + `onConnectionChanged` 订阅两条通道比对（旧版还验证 `openWorkspace`）；「bridge 与 main 注册渠道一致」的契约覆盖从 3 条降为 2 条。
- **wire 兼容**：本提交不改任何 RPC 参数/流帧；`cloudPlatformExposure()` 签名收窄为无参，唯一调用点 `preload/index.ts:185` 同步更新，无旧调用方残留（typecheck 通过）。

## 4. 规范

- **ui/ 原语（通过）**：13 文件无一位于 `components/ui/`；仅 import `button`/`dialog`/`input`/`label`。`sm:max-w-sm` 覆盖 DialogContent 默认宽度经 `cn`（twMerge）合并生效（`lib/utils.ts:5`）。
- **token / className（通过）**：新增 class 全为静态字面量 + 设计 token（`text-muted-foreground`、`bg-background`、`bg-card`、`border-border/50`、`text-destructive`）；无裸色值、无计算 className。实测 changed-code-quality 门：design system 0 findings（501 changed files）。
- **max-lines（通过）**：按 oxlint 实际口径（skipBlankLines+skipComments）——`cloud-platform.ts` 276/300、`cloud-workspace-entry.tsx` 296/400（tsx）、`cloud-login-panel.tsx` 177/400、`cloud-login-entry.tsx` 79/400、`cloud-workspace-banners.tsx` 87/400、`cloud-platform-exposure.ts` 5/300；测试文件均 <800。无任何新增 lint disable；`check:max-lines-ratchet` 通过（7 个既有豁免，无新 bypass）。
- **命名（通过）**：`cloud-login-entry.tsx` / `CloudLoginForm` 均为具体域概念；无 helpers/utils 类命名。
- **注释密度（通过）**：新增 Why 注释均 1–3 行且解释动机（如 `cloud-login-entry.tsx:37-39` 弹框状态生命周期、`cloud-platform.ts:277-278` 恢复门）。一处注释与实现不符见 m1。
- **diff 归属（13/13 归属 W11）**：

| 文件 | 归属 |
|---|---|
| `src/main/ipc/cloud-platform.ts` | W11 核心：全构建装配 + 恢复门 |
| `src/main/ipc/cloud-platform-login-gate.test.ts` | W11 边界断言（3 新例 + null→non-null 适配） |
| `src/main/startup/cloud-runtime-admission-env.test.ts` | W11 适配 + 1 处顺带的断言风格改写（`as Error`→`toHaveProperty`，与 AGENTS「优先 checked types」一致但与登录语义无关，记 note n6） |
| `src/preload/cloud-platform-exposure.ts` | W11：无条件暴露 |
| `src/preload/cloud-platform-exposure.test.ts` | W11：契约改写（覆盖收窄见 m3） |
| `src/preload/index.ts` | W11：1 行调用点适配 |
| `src/renderer/src/App.cloud-mode-regression.test.tsx` | W11：主工作流不变断言（强度见 M2） |
| `src/renderer/src/App.cloud-workspace-entry.test.tsx` | W11：弹框化登录流程改写 |
| `src/renderer/src/cloud/cloud-login-entry.tsx` | W11 新增：chip + 弹框 |
| `src/renderer/src/cloud/cloud-login-entry.test.tsx` | W11 新增：6 例 |
| `src/renderer/src/cloud/cloud-login-panel.tsx` | W11：表单抽取 |
| `src/renderer/src/cloud/cloud-workspace-banners.tsx` | W11：新建项目按钮容器迁移 |
| `src/renderer/src/cloud/cloud-workspace-entry.tsx` | W11：去整页接管 + signOut 接线 |

## 5. 测试质量

**6 个新例（`cloud-login-entry.test.tsx`）可变红性逐条**：

| 例 | 行 | 断言对象 | 评价 |
|---|---|---|---|
| 零 env 也有按钮、地址留空 | 55 | 无 loginContext 时按钮存在、地址空 | 可变红；但「零 env」是 main 语义，此例实际只证 UI 对 null 预填的处理，命名夸大（m5） |
| Escape/遮罩关闭 | 64 | 弹框开→关 | 可变红，交互真实（含二次打开） |
| 预填 + 成功后关闭 | 87 | 地址/账号值、`signIn` 参数、signed-in 后弹框关、显示账户 | 可变红；通过手工 rerender 驱动 `open && !signedIn` 派生逻辑，未走 hook 内部状态转移，可接受 |
| 失败内联报错保持打开 | 125 | `alert` 文案 + 字段仍在 | 可变红 |
| 托管地址只读 | 150 | disabled + 值 + 说明文案 | 可变红 |
| 登出顺序 | 166 | `onSignOut` 先于 `session.signOut`（`invocationCallOrder`） | 可变红，顺序断言强 |

**5 处修订断言**：gate 测试 3 个新例（131/146/158 行）直接可变红且正中「不自动登录」要害；admission-env 修订例（97-107 行）锁定「无 env 仍装配登录入口、准入仍为 null」；`App.cloud-workspace-entry` 的 `signIn()` 助手改为「点 chip→等弹框→填写」，并新增「弹框开着时 shell 仍在」「签入后 chip 显示账户+登出」两条，可变红；`App.cloud-mode-regression` 修订例断言 shell+chip+弹框关+`login`/`registerProjects` 未调用+无全页登录标题，方向正确但强度受 M2 限制。

**「主工作流不变」断言强度（不足 → M2）**：`AppWorkspaceShell` 被 mock 成 30-31 行的单个 div 桩，「shell 渲染」仅是挂载证明；无侧栏/添加项目/配对入口存在性断言，happy-dom 也无法检出几何遮蔽。建议补一条「签出态下 `data-cloud-login-entry` 与原生侧栏同时存在」的真实壳渲染冒烟（CDP 截图即可补齐遮蔽证据）。

**实测证据**：7 个触及测试文件复跑 37 例全绿（cloud-login-panel + cloud-login-entry + App.cloud-mode-regression + cloud-platform-exposure = 15；App.cloud-workspace-entry + cloud-platform-login-gate + cloud-runtime-admission-env = 22）；`npx oxlint`（1.86.0）0 findings；`check-changed-code-quality.mjs` 仅 2 条与本提交无关的发现（`src/relay/agent-exec-disposal.test.ts:129`，分支既有）；`verify-localization-extraction` exit 0。

---

## 发现清单

### Major

- **M1 常驻 chip 遮蔽状态栏右端原生控件（§4.2b 违反）** — `cloud-login-entry.tsx:48` 的 `fixed bottom-3 right-3 z-40`（占位 12–36px）压在 in-flow 状态栏（0–24px，默认可见）上半区，右缘与 `px-3` 内边距对齐，盖住悬浮终端开关（`size-5`）与 `StatusBarVisibilityMenu` 等最右侧原生交互控件的上半，容器可拦截点击；同角还有 sonner `bottom-right` Toast 互相覆盖。W10 时代该坐标只存在于云构建签入态，W11 推广到全构建全状态后构成对「云端功能不得遮蔽原生入口」的实质违反。建议：锚到状态栏之上（`STATUS_BAR_RESERVE_HEIGHT` + gap）或做成状态栏原生 segment。
- **M2 「原生 shell 全状态渲染 / 纯加法」无有效测试** — `App.cloud-mode-regression.test.tsx:29-31` 的 shell 是单 div 桩；断言集既不能发现原生入口缺失，也不能发现遮蔽（M1 即在盲区发生）。核心设计约束目前「不可变红」。

### Minor

- **m1 登出链失败中间态 + 静默失败 + 重复登出** — `cloud-login-entry.tsx:43-48` 异步链无 catch：`entry.signOut()` 内 `ports.signOut()`（`cloud-entry-workspace-sync.ts:33-38`）先 `bridge.logout()`（此时 main 已结束会话）再 `hydrateRuntimeEnvironmentStatuses()`，任一步 reject 则 `purgeRepos` 不执行（侧栏残留死行）、`session.signOut()` 不执行（视图停留 signed-in）、rejection 无提示。且 `session.signOut()` 会对 main 发起第二次 `logout`（幂等但多一轮 IPC + 重复 hydrate）；`cloud-login-entry.tsx:33` 的注释「Retires the signed-in account's repos before the session itself ends」与实现不符——ports.signOut 本身就已结束会话。
- **m2 `NewCloudProjectButton` 容器迁移零断言** — 无任何测试引用该按钮或 `leading` 槽位；提交信息声明的「shares the entry's corner」无回归保护。
- **m3 preload 契约断言收窄** — 通道比对从 3 条（login/openWorkspace/onConnectionChanged）降为 2 条。
- **m4 「不自动登录」未覆盖磁盘已存 saved session 的中间态** — gate 测试 146 行用空 userDataPath；真实 dev 场景（先带 env 登录、后无 env 启动）由 `isCloudPlatformBuild` 结构保证，但无断言。
- **m5 新例命名夸大覆盖面** — 「零 env 开发模式」例实际只测 loginContext 为 null 的 UI 形态。
- **m6 文案双写 + i18n 不一致** — 弹框标题/描述（`cloud-login-entry.tsx:75-76`）与 `CloudLoginPanel`（`cloud-login-panel.tsx:73-74`）同一中文串两份维护，且同组件内按钮走 `translate('auto.cloud.…')`、标题硬编码；`auto.cloud.*` 键族整体未落 locale 目录（extraction 门 report-only 既有豁免，新键 `auto.cloud.login/signOut` 沿用）。

### Note

- **n1** 契约零回归的成立方式：`CloudLoginForm` 抽取为逐字搬运，全页壳 class 未变，`cloud-app.tsx` 调用点未改，7 例既有测试经由组合组件全绿；壳 class 本身仍无断言（既有缺口）。
- **n2** 设计文档失同步：`design-adjustment-native-ui.md` §4.1 仍写「`api.cloud` 仅云端构建暴露」，与 §4.2 的 W11 修订（全构建常驻按钮）矛盾，按 §4.1 审会误判 W11 违规，建议补一句「§4.1 该句被 §4.2 W11 修订覆盖」。
- **n3** 与 web 登录版（`WebConnectCloudForm`）的差异：web 版多「设备名」字段，桌面 `CloudLoginForm` 无（桌面设备名自动生成，W10 既有）；FR-2.7 文字仅要求「平台地址预填+域账号」，不判违规，记录差异。
- **n4** Radix Dialog 内保留 `autoFocus`（`cloud-login-panel.tsx` 用户名输入）：happy-dom 下通过；真实环境建议人工核一次初始焦点与 Radix 焦点陷阱的交互。
- **n5** 生产路径 `attachCloudRuntime`（`cloud-runtime-admission.ts:314`）丢弃 `installCloudPlatformIpc()` 返回值，`dispose`/`setActiveCloudSession(null)` 无人调用——既有模式，W11 后 handler 常驻属预期，惰性无害。
- **n6** `cloud-runtime-admission-env.test.ts:135-138` 的 `toHaveProperty/stringContaining` 改写移除了一个 `as Error` 断言（合 AGENTS「优先 checked types」），但与 W11 语义无关，属顺带改动。
- **n7** 安全面正向结论汇总：signed-out 桌面构建所有 `cloud:*` handler 短路；密码不落盘/不进日志；登录记忆仅地址+用户名且读写实现未触碰；`setActiveCloudSession` 无生产读者。剩余敞口是「非托管构建可向任意 https 地址提交域账号」的钓鱼面，属 W11 决策固有属性。
- **n8** 门禁实测：7 个触及测试文件 37 例全绿；oxlint 0；design system 0；max-lines ratchet 通过（`cloud-platform.ts` 有效 276/300、`cloud-workspace-entry.tsx` 296/400）；localization extraction exit 0。
