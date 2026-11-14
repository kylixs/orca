# O1 · 云会话启动残余被拒 RPC 族：诊断 + 修复设计（只读）

- 日期：2026-11-14
- 作者：O1 设计代理（只读静态分析，未改任何产品代码、未提交 git）
- 快照：HEAD `80a5bbd897c`（W13a `f160524e19d` 已提交；W13b（web 云工作区视图）**在途未提交**——`web-cloud-workspace-bootstrap.ts` 等 14 个 src 文件在工作树。本设计的「启动链」按**工作树现状**（W13a+W13b）判定。
- 输入：`coverage-review-2026-11-14.md`、`test-reports/chain-coverage-audit.md`、`test-reports/w7c-audit.md`、`work-orders/w13-cloud-workspace-view-design.md` §4.6、PROGRESS.md「O1=云工作区启动仍有 7 个被拒 RPC」挂账（L2818）、W13 Q5（L339）。
- 方法：静态差集 + 启动链触发点逐条对照，零运行时依赖。

---

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 云宿主登记方法全集 | 674 个（`CLOUD_HOST_METHODS` = `ALL_RPC_METHODS` + managed worktree + `project.provision` + `workspace.info`；非测试方法声明去重，`find src/main/runtime/rpc -name "*.ts" ! -name "*.test.ts"` 可复算） |
| 其中云准入**拒绝**的 | **430 个**（`cloudMethodAccess()` 返回 `null`；放行 244） |
| 启动/水合链上**实际会被发出且被拒**的族 | **9 族**（W7c 挂账的 7 族全部复核成立 + W13b 点亮工作区后新增 2 族） |
| 最高优先 | **F7 `session.tabs.*` + `runtime.clientEvents.subscribe`（桌面客户端完全未门控，订阅失败 warn-loop）**、**F8 `worktree.activate`（每次激活工作区必发一次被拒调用）** |
| 逐族裁定 | (a) 宿主登记 1 族（preflight.detect*）；(a) 候选 1 族（nativeChat.readSession，需会话 scope 证明）；(b) 客户端跳过 6 族；其余保持拒绝 + UX 呈现 |

> 「mobile 允许清单外」的含义：HEAD 的 scope 判定已把 cloud 放在 mobile 之前（`rpc-caller-scope.ts:81-90`、`runtime-rpc-websocket-dispatch.ts:88-96` 注释「Why before the mobile check」），所以残余拒绝全部落在**云方法表层**（`Method 'x' is not available to cloud sessions`）；mobile 允许清单层只在「设备行缺 `cloudSession` 的陈旧/降级行」时才重新出现（W5a 事故形态）。生产一致性测试要求见 §4.0。

---

## 1. 拒绝层模型（判「被拒层」用）

| 层 | 代码位置 | 拒绝文案/错误码 | 触发条件 |
| --- | --- | --- | --- |
| L1 云方法表 | `src/main/cloud-platform/cloud-rpc-permission.ts:91-120`（表）→ `src/main/runtime/rpc/rpc-caller-scope.ts:38-58`（裁定） | `forbidden` + `Method 'x' is not available to cloud sessions` | 方法不在任何云权限集合/前缀 |
| L2 权限位 | 同上 `rpc-caller-scope.ts:49-51` | `needs the 'terminal' project permission, which this cloud session was not granted` | 在表内但票据无该权限位 |
| L3 策略 | `rpc-caller-scope.ts:53-56` | `downloads are disabled for this project by platform policy` | `download` 族 + 项目策略 deny |
| L4 路径守卫 | `src/main/cloud-platform/cloud-path-guard.ts` + `cloud-file-path-params.ts`（`CLOUD_FILE_UNBOUNDED_METHODS`） | `path_denied / PATH_OUTSIDE_ROOT / path_unverifiable` | 权限在表内、但参数（绝对路径/越界 repo）钉不住 |
| L5 宿主未实现 | dispatcher（未注册 → `method_not_found`；老宿主对未注册方法在权限阶段答 `forbidden`） | `method_not_found` | W13a 之前的宿主缺 `workspace.info`（已收口） |
| L6 mobile 允许清单 | `rpc-caller-scope.ts:81-85` | `forbidden` + `not available to mobile clients`（**无 denial details**） | 仅当 scope 被映射成 `mobile`（陈旧行） |

W7c 已修的「客户端跳过」清单（保持不动，本文档不重复展开）：`repo.list` / `projectGroup.list` / `folderWorkspace.list` / `ssh.*` 水合 / `worktree.lineageList`（web 启动链） / `runtime.clientEvents.subscribe`（web） / `session.tabs.*`（web）——分别在 `all-host-repo-catalog-actions.ts:160`、`project-group-catalog-actions.ts:88`、`folder-workspace-catalog-actions.ts:121`、`use-app-startup-hydration.ts:96-161,261-265`、`global-session-subscription.ts:70`、`active-session-subscription.ts:76`、`runtime-client-ipc-bridge.ts:177-179,234-241`、`direct-ssh-state-ipc-bridge.ts:64`。

---

## 2. 残余族清单（启动/水合链上真的会发且被拒）

触发时机标注：**boot**=页面/App 启动链必发；**lit**=W13b 点亮工作区后随首屏组件/激活必发；**demand**=用户动作/面板打开时。

### F1 · `ui.*` —— UI 偏好族（web 启动链）
| 项 | 内容 |
| --- | --- |
| 方法 | `ui.get`、`ui.set`、`ui.setWithAck`、`ui.recordFeatureInteraction` |
| 发起点 | `src/renderer/src/web/preload-api/web-ui-api.ts:46`（get，boot 链 `use-app-startup-hydration.ts:125` `ui-get` 步）、`:83/:95`（set/setWithAck，每次偏好写）、`:120`（recordFeatureInteraction，首次功能交互） |
| 被拒层 | L1（不在云表） |
| 症状 | get：被拒 → catch → localStorage 本地回退（W7c MIN-4 已记录，噪声为零）；set：本地先写、宿主写**静默丢弃**；`setWithAck`：抛错 → 偏好 diff writer 拒绝 ack（该偏好每次启动重发一次 doomed RPC） |
| 影响面 | 仅 web（桌面 `window.api.ui.*` 走本地 main IPC，零 RPC） |

### F2 · `settings.*` —— 运行时共享设置族（web 启动链）
| 项 | 内容 |
| --- | --- |
| 方法 | `settings.get`、`settings.update`、`settings.updatePRBotAuthorOverride`（按需还有 `settings.getTerminalQuickCommands`、`settings.mutateNativeChatSessionOptions`） |
| 发起点 | `src/renderer/src/web/preload-api/web-preferences-store.ts:117-121`（get，boot 链 `fetchSettings` 必经）、`:236-240`（update，任何设置写）、`:273`（updatePRBotAuthorOverride）；`web-settings-api.ts:96` |
| 被拒层 | L1 |
| 症状 | get：catch → 纯本地（运行时共享键 `worktreeVisibilityDefaults`/`compactWorktreeCards`/`minimax*`/`prBotAuthorOverrides`/`artifactSharingEnabled`/`agentSkillSharingEnabled` 镜像全部落默认）；update：写本地、宿主侧**静默丢**（用户改了设置，重载后「回跳」，无任何提示） |
| 影响面 | 仅 web（桌面设置是本地 main） |

### F3 · `preflight.*` —— 宿主探测族（composer / 空 workspace 默认 agent）
| 项 | 内容 |
| --- | --- |
| 方法 | `preflight.detectAgents`、`preflight.refreshAgents`（→ 老宿主回落 detectAgents）、`preflight.check`、`preflight.detectRemoteAgents` |
| 发起点 | `src/renderer/src/store/slices/runtime-detected-agents.ts:144`（detect）、`:203`（refresh）；web：`web/preload-api/web-host-capability-api.ts:65,74,84`（各带 `.catch(()=>[])` 或 catch）；触发：`lib/empty-workspace-default-agent-chat.ts` → `lib/agent-detection-target-inventory.ts:45`（**空 workspace 首屏**）、`hooks/composer-state/host-runtime-effects.ts:70`（新建工作台 composer 选中云环境）、`components/skills/use-skill-install-detected-agents.ts:22,29`、`store/slices/preflight.ts:96`（check，composer/任务页） |
| 被拒层 | L1 |
| 症状 | **静默降级为空清单**：agent 选择器为空 → 云工作区首终端默认 agent 退化为 catalog 默认；composer 的「检测到的 agent」区空。探测失败可重试（菜单），但用户不知道为什么空 |

### F4 · `skills.*` —— 技能族（agent 面点亮后）
| 项 | 内容 |
| --- | --- |
| 方法 | `skills.discover`（+ 管理面 `install/delete/share/listManagedInstalls/...`） |
| 发起点 | `src/renderer/src/web/preload-api/web-host-capability-api.ts:151`（discover，15s）、`components/native-chat/use-native-chat-skills.ts:251`（**agent 会话聊天面板挂载时**）、`runtime/runtime-skills-client.ts:48` |
| 被拒层 | L1 |
| 症状 | agent 会话技能列表空/加载失败（发现结果不缓存 → 每次打开都发一次 doomed RPC）；技能管理页报错或空 |

### F5 · 集成面族 `github.*` / `gitlab.*` / `linear.*` / `jira.*` / `hostedReview.*`
| 项 | 内容 |
| --- | --- |
| 方法 | 启动相邻：`github.prForBranch`（git 面板点亮后随分支/激活刷新）；其余按需：`github.prChecks/prFileContents/mergePR/...`、`gitlab.*`、`linear.status`（任务源/onboarding 遥测）、`hostedReview.create/...` |
| 发起点 | `src/renderer/src/store/github/pull-request-execution.ts:77`（prForBranch，**每次 `setActiveWorktree` 都触发 GitHub 刷新**，`lib/worktree-activation.ts:219` 注释）；linear：`runtime/runtime-linear-client.ts:106`；web 通用转发：`web/web-preload-api.ts:94-95`（`createRuntimeNamespaceApi('hostedReview'/'linear')`）、`web-github-api.ts`/`web-gitlab-api.ts` |
| 被拒层 | L1 |
| 症状 | git 面板的 PR 区空（请求 30s 超时或立即 forbidden，视缓存）；PR/审查按钮失效；无明确「云会话不支持」说明——用户看到的是「这个仓库没有 PR」 |

### F6 · 会话元数据族 `aiVault.*` + `nativeChat.*`
| 项 | 内容 |
| --- | --- |
| 方法 | `aiVault.resolveSessionTitles`、`aiVault.searchSessions`、`aiVault.listSessions/prepareSessionResume/searchStatus`；`nativeChat.readSession`、`nativeChat.subscribe`/`unsubscribe` |
| 发起点 | `src/renderer/src/components/AiVaultTabTitleSyncGate.tsx:16`（标题后台同步，存在结构化会话标签时）、`components/right-sidebar/use-ai-vault-search.ts:73,80`（右侧栏 AI Vault 搜索）；`components/native-chat/native-chat-session-transport.ts:47-59,107`、web：`web/preload-api/web-native-chat-api.ts:15`（**打开 agent 会话聊天时**） |
| 被拒层 | L1 |
| 症状 | 标题同步/搜索静默空；**agent 会话聊天（W13b 点亮面）转录加载失败**——这是点亮后最影响观感的一条（用户能开终端但聊天会话历史打不开） |

### F7 · 配对镜像族 `session.tabs.*` + `runtime.clientEvents.subscribe` —— **桌面客户端完全未门控**（本次复核新发现）
| 项 | 内容 |
| --- | --- |
| 方法 | `session.tabs.listAll`、`session.tabs.subscribeAll`、`session.tabs.subscribe`（+ `activate/close/createTerminal/...` 按需）；`runtime.clientEvents.subscribe` |
| 发起点 | `src/renderer/src/runtime/web-session-tabs-sync/load-initial.ts:48`（listAll，15s）、`global-session-subscription.ts:149`（subscribeAll）、`active-session-subscription.ts:221`（subscribe）；安装点 `app-shell/use-app-shell-services.ts:44`（**桌面/ web 共用 App shell**）；镜像环境集来自 `runtime/use-runtime-session-mirror-environment-key.ts`（按 repo/worktree 归属推导——**云环境拥有云 repo 行与 worktree，必然入选**）；client-events：`hooks/ipc-events/runtime-client-ipc-bridge.ts:177-179,234-241` |
| 被拒层 | L1 |
| 症状 | 现有门 `isActiveWebClientCloudSession()` 是 **web-only**（`web-cloud-session-scope.ts:27-37`，`isWebClientLocation()` 短路）：桌面客户端登录云项目后，这些订阅照发 → 每环境启动一次 `listAll` + `subscribeAll` + active `subscribe` 被拒，`console.warn('[web-session-tabs-sync] initial listAll failed: …')`；可见性恢复/重连/重定目标时**反复重订阅**（warn-loop，与 `global-session-subscription.ts:68-69` 注释预言的形态一致）。`runtime.clientEvents.subscribe` 同理（失败回放路径还会触发 per-environment 状态刷新调度） |
| 影响面 | 桌面云项目会话（W12 桌面形态）；web 已被 W7c 门控 |

### F8 · worktree 宿主通知/元数据族 `worktree.activate` / `worktree.set` / `worktree.lineageList` / `worktree.listRetiredNames` 等
| 项 | 内容 |
| --- | --- |
| 方法 | `worktree.activate`（宿主通知）、`worktree.set`（lineage/meta/排序/diff 评论写）、`worktree.lineageList`（桌面延迟刷新）、`worktree.listRetiredNames`、`worktree.persistSortOrder`、`worktree.prefetchCreateBase`、`worktree.resolveMrBase/resolvePrBase`、`worktree.ps`/`sleep`/`teardownMissingTerminals`（宿主全景态） |
| 发起点 | **`worktree.activate`：`src/renderer/src/runtime/web-runtime-worktree-activation.ts:31`，调用点 `lib/worktree-activation.ts:234`——这是共享激活管线**：门是 `isWebRuntimeSessionActive()`＝「worktree 归属任何 runtime 环境」(`web-runtime-session-environment.ts:5-10`)，**不区分云**。W13b bootstrap 用的是裸 `setActiveWorktree`（绕开），但用户点侧栏另一工作区、Cmd+J 跳转等一切走 reveal 管线的激活都会发一次被拒的 activate + `console.warn('[web-runtime-session] failed to activate worktree: …')`；`worktree.set`：`store/slices/worktrees/metadata/worktree-meta-persist.ts:165`、`store/slices/diff-comment-persistence.ts:98`、`worktree-lineage-refresh.ts:121`；`worktree.lineageList`：`worktree-lineage-refresh.ts:71`（目标=`getActiveRuntimeTarget(settings)`，云环境激活时即云宿主；桌面延迟刷新 `app-shell/startup-remote-catalog-refresh.ts:54` 未按环境跳过 → `refreshRemoteWorktreeLineageBestEffort` 的 `console.error('Failed to fetch worktree lineage:', …)`，`worktree-lineage-refresh.ts:289`）；`worktree.listRetiredNames`：`web/preload-api/web-worktrees-api.ts:53` |
| 被拒层 | L1（云 worktree 表 `cloud-rpc-permission.ts:78-87` 只登记 create/createManaged/rm/forceDeleteBranch/show/list/detectedList） |
| 症状 | 每次激活一条 warn；lineage 每轮延迟刷新一条 error 噪声；排序/元数据写静默不持久（云会话内可接受，但无说明） |

### F9 · 路径守卫族（权限内、`path_denied`）`files.browseServerDir` / `files.resolveTerminalPath` / `files.readTerminalArtifact*`
| 项 | 内容 |
| --- | --- |
| 方法与层 | 三者都在云 READ 集合（L2 不拒），但被 L4 路径守卫按绝对路径/无界参数拒绝（`cloud-file-path-params.ts:44-59`） |
| 发起点 | `runtime/runtime-server-directory-browser.ts:17`、`web/preload-api/web-repositories-api.ts:96`（新建工作台/添加目录的**服务器目录浏览**）；`components/quick-open-file-navigation.ts:85,97`（quick open 的终端相对路径解析） |
| 症状 | 云会话下「添加文件夹工作区/浏览服务器目录」走不通（这是**设计意图**：票据只有 projectRoot）；quick open 的路径解析失败回退到 files.searchPaths（可用）。终端 scrollback 不走 artifact（走 `terminal.multiplex` 重放，W5c/W9A-7），无新增缺口 |

> 与 W13 §4.6「仍被拒（预期内）」清单的差异：该清单为 W13a 时点基线。本次复核新增的证据点——(1) `session.tabs.*`/`runtime.clientEvents.subscribe` 在**桌面**未门控（W13 只修了 web）；(2) `worktree.activate` 在**共享激活管线**上未门控；(3) `nativeChat.readSession` 因 W13b 点亮 agent 面从「链外按需」升级为「点亮面核心路径」；(4) `github.prForBranch` 随每次激活必发。这四条即「W13c 点亮面清单」应重点采集的观测对象。

---

## 3. 逐族修复设计

裁定选项：(a) 宿主登记（对齐 `workspace.info` 先例：**返回值字段即白名单**，方法只回票据域内事实）；(b) 客户端云会话跳过（对齐 `repo.list` 先例 `9a27c7963de`：**按环境/按 scope 判定，而非 web-only 谓词**）；(c) 保持拒绝 + 改善呈现。

### F1 `ui.*` → **(b) 跳过**
- 理由：ui 偏好是**客户端形态的本地态**（桌面/浏览器各自 localStorage），云票据没有「共享 UI 态」的对端；W7c MIN-4 已定性为「已知豁免」。把它升格为 (a) 会把一个浏览器的界面偏好写进宿主共享态，语义错位。
- 改法：`web-ui-api.ts` 的 get/set/setWithAck/recordFeatureInteraction 在 `isActiveWebClientCloudSession()` 为真时直接走本地分支（不发起 `callRuntimeResult`）；`setWithAck` 在云会话返回本地成功（偏好 writer 不再无限重发）。
- 影响面：仅 `web-ui-api.ts` + 其测试；桌面零变化（本来就不走 RPC）。

### F2 `settings.*` → **(b) 跳过**
- 理由：`getRuntimeBackedStoredSettings`/`syncRuntimeBackedSettings` 的运行时键是「配对桌面 ↔ 宿主」共享语义（`web-preferences-store.ts` 内注释），云票据没有配对对端；本地 localStorage 已是 web 云会话的权威。与 `repo.list` 跳过同构：注定被拒的读不发起。
- 改法：两个函数入口在云会话短路（返回本地 / 只写本地）；`updatePRBotAuthorOverride` 同样短路并回显本地值。
- 影响面：`web-preferences-store.ts` + `web-settings-api.ts` + 测试；**注意保留** `settingsForActiveVisibilityOwner` 的可见性默认语义（云会话没有宿主默认 → 用全局默认，不要把「无宿主值」误判为「宿主拒绝」）。

### F3 `preflight.detectAgents` / `preflight.refreshAgents` → **(a) 宿主登记为 `agent` 权限**；`preflight.check` / `preflight.detectRemoteAgents` → **(c) 保持拒绝 + 客户端跳过**
- (a) 理由：检测结果（宿主装了哪些 agent CLI）是**agent 面的必要输入**，且调用方本来就持 `agent` 权限去启动这些 CLI；对齐 `agentSession.*`→`agent` 的前缀先例。做法：`cloud-rpc-permission.ts` 新增集合 `AGENT_PROBE_METHODS = {'preflight.detectAgents','preflight.refreshAgents'}` → `'agent'`；并登记进 `cloud-agent-scope.ts` 的 scope 校验（检测以参数里的 workspace/worktree 为界，宿主把探测 cwd 钉在 ticket `workspaceRoot` 内——与 `checkCloudAgentScope` 既有机制一致）；mobile 允许清单**不动**（手机仍走清单语义）。
- (c) 理由：`preflight.check` 返回全宿主能力面（OS/shell/git 版本/磁盘），`detectRemoteAgents` 触及宿主全部 SSH 目标——都是「主机渠道」事实，放行即把项目票据升格（W7c §2.1 已论证的边界）。客户端：composer/任务页在云会话隐藏「新建工作台」入口（云项目固定，composer 无意义）或对 check 失败显示「云会话不提供宿主诊断」而非空态。
- 影响面：`cloud-rpc-permission.ts`、`cloud-agent-scope.ts`、真栈负向测试（无 `agent` 权限的票据 → L2 拒绝）；renderer 侧 composer 的云分支。
- 若实现代理评估 scope 证明成本过高（探测进程 cwd 无法钉住），降级为 (b)：空 workspace 默认 agent 走 catalog 内置清单，不发探测。

### F4 `skills.*` → **(b) 跳过 + (c) 呈现**
- 理由：技能目录是**宿主全局用户目录**（`~/.claude/skills` 等）——跨项目泄露面，W13 §4 边界明确不动；与 F5 同属「宿主级资产」。
- 改法：`use-native-chat-skills.ts` / `runtime-skills-client.ts` 在云会话短路为「内置 catalog 清单」；技能管理入口在云会话渲染「宿主技能在云会话不可用」的文档型说明（复用 `CloudSessionEmptyState` 的呈现模式，不新造样式）。
- 影响面：renderer 两个调用点 + 一条空态文案。

### F5 集成面 `github.*`/`gitlab.*`/`linear.*`/`jira.*`/`hostedReview.*` → **(c) 保持拒绝 + (b) 高频点短路**
- 理由：集成的凭据是宿主账号资产（`accounts.*` 同层），项目票据不该携带；`github.prForBranch` 虽然参数是项目分支，但它消费的是宿主 GitHub token 与仓库全量可见性——不在票据域。
- 改法：PR 区在云会话渲染「云会话不支持 PR 集成」占位（不发起请求、不显示「无 PR」）；`linear.status`/任务源在云会话短路为未连接。其余面板按需触发，出现拒绝时走既有错误处理（可接受）。
- 影响面：`pull-request-execution.ts` 的云分支（或其上层 store 判定）+ PR 区组件占位；不新增宿主表项。

### F6 `aiVault.*` → **(b) 跳过**；`nativeChat.readSession/subscribe/unsubscribe` → **(a) 候选（首选）**，scope 不可证明则退 (b)
- `aiVault` 理由：跨项目会话检索/标题解析是宿主全域面，跳过后标题回落文件名、搜索显示「云会话不可用」。
- `nativeChat` 理由：W13b 点亮 agent 面后，「打开会话 → 转录加载」是核心旅程；`agentSession.*` 已在云表（`'agent'` 前缀）且宿主有 `checkCloudAgentScope` 把会话钉在 ticket workspace——`nativeChat.readSession` 的参数正是 (agent, sessionId, transcriptPath)。(a) 做法：登记三方法为 `'agent'`，并在 `cloud-agent-scope.ts` 增加会话归属校验（sessionId 解析出的 worktree ∈ ticket workspaceRoot；`transcriptPath` 若客户端可传则必须落在该 worktree 内，否则忽略参数由宿主自解析）。**前提验证点**：宿主能否从 sessionId 可靠解析归属（`resolveAgentSessionContext` 已存在于 `cloud-path-guard.ts` 的 runtime 能力里，复用即可）。
- 退 (b) 条件：归属解析不可靠（孤儿会话/跨 worktree 粘贴）→ 保持拒绝，聊天面板显示「云会话不加载历史转录」，实时增量流（`terminal.multiplex`）不受影响。
- 影响面：(a) = `cloud-rpc-permission.ts` + `cloud-agent-scope.ts` + 真栈正/负测试；(b) = `native-chat-session-transport.ts` 云分支 + 空态。

### F7 `session.tabs.*` + `runtime.clientEvents.subscribe` → **(b) 跳过（把 web-only 门升级为按环境判定）**——本设计最高优先
- 理由：这两个族是「配对桌面 ↔ 宿主」镜像协议；云票据**不是**配对 UI（`rpc-caller-scope.ts:60-69` 注释把云明确排除在 paired UI 权限外）。现状是桌面端每环境一次 doomed `listAll` + 两条订阅 + 失败回放调度，全部 warn-loop——纯浪费 + 噪声 + 掩盖真错误。
- 改法：新增共享谓词 `isCloudProjectRuntimeEnvironmentId(environmentId)`（基于 `runtimeEnvironments` 里的 `cloudProject` 字段，复用 `src/shared/runtime-environments.ts:254` 的判定，不要新造标准），替换三处 web-only 门：
  1. `use-web-session-tabs-sync.ts`：镜像环境集在传入 `installGlobalSessionTabsSubscriptions`/`installActiveSessionTabsSubscription` 前过滤云环境（或在两个 installer 里把 `isActiveWebClientCloudSession()` 换成「目标环境是否云」——推荐后者，粒度对齐 `9a27c7963de`）；
  2. `runtime-client-ipc-bridge.ts:177-179,234-241`：`desiredEnvironmentIds`/`getReachableEnvironmentIds` 过滤云环境（桌面同样生效）；
  3. `web-cloud-session-scope.ts` 保持不动（web 启动链全量跳过仍是想要的）。
- 影响面：`web-session-tabs-sync/*`、`runtime-client-ipc-bridge.ts` + 各自测试；**零宿主改动、零 wire 变化**。

### F8 `worktree.activate` / `worktree.set` / `worktree.lineageList` → **(b) 跳过**（分两档）
- `worktree.activate`：激活管线的宿主通知在云会话没有意义（没有第二个配对端要通知；W13b bootstrap 注释 `web-cloud-workspace-bootstrap.ts:121-124` 已定性）。改法：`worktree-activation.ts:233` 的门加「owner 环境是云 → 跳过 notify」（复用 F7 的共享谓词）。
- `worktree.lineageList`：`startup-remote-catalog-refresh.ts` 的 lineage 步与 `refreshRemoteWorktreeLineageBestEffort` 对云环境跳过（宿主全域谱系，Web 已跳，桌面补齐）。改法：lineage 刷新目标解析时若 `getActiveRuntimeTarget` 指向云环境则直接返回空。
- `worktree.set`（排序/元数据/diff 评论写）：**(b)**——云会话本地态即可；若未来要跨设备共享 worktree 元数据，再按 (a) `'terminal'` + worktree-scope 校验立项（`cloud-worktree-scope.ts` 已有 repo-scoped 判定可复用）。`worktree.listRetiredNames`/`persistSortOrder` 同档。
- 保持拒绝（无需改）：`worktree.ps`/`sleep`/`teardownMissingTerminals`（宿主窗面/全景态）、`worktree.prefetchCreateBase`（云建区固定走 `worktree.createManaged`，创建对话框在云会话隐藏 base 预取）。

### F9 路径守卫族 → **(c) 保持拒绝 + 呈现**（零改动候选）
- `files.browseServerDir`：云会话的「添加目录」流程本就该走平台自助建项目（W1），composer 在云会话隐藏该入口即可。
- `files.resolveTerminalPath`：quick open 已有 `files.searchPaths` 回退，无需改；如要降噪可在云会话先走 searchPaths。
- `files.readTerminalArtifact*`：mobile 专用消费路径；云会话 scrollback 走 multiplex 重放，**不需要任何改动**（仅在 W13c 清单里记录为「已验证无缺口」）。

### 通用原则（写进实现令的纪律）
1. **客户端跳过一律按环境判定**（`cloudProject` 字段 / 设备票据事实），不再新增 web-only 谓词分支；`isActiveWebClientCloudSession()` 保留给「web 启动链全量跳过」这一个用途。
2. **宿主登记一律伴随护栏**：新进云表的方法必须同时登记进对应 scope 守卫（`cloud-agent-scope` / `cloud-worktree-scope` / `cloud-path-guard`），并在 `cloud-rpc-permission.test.ts` 加「未持该权限位 → L2 拒绝」负向。
3. **拒绝不再是静默的**：每个保持拒绝的面（F4/F5/F9）给出一条文档型说明或占位，杜绝「看起来像数据为空」的呈现（W7c 后用户实测断裂的教训）。

---

## 4. 测试方案

### 4.0 生产一致性硬约束（每个实现令必须满足）
1. **真栈宿主方法表 = 生产四件套**（`ALL_RPC_METHODS + MANAGED_WORKTREE_METHODS + PROJECT_PROVISION_METHODS + WORKSPACE_INFO_METHODS`，即 `CLOUD_HOST_METHODS`），harness 从同一常量组装并加守卫断言 `hasWorkspaceInfo(registered)===true`（`web-cloud-handoff-entry.e2e.test.ts` / `cloud-admin-session.e2e.test.ts` 的缩水表必须替换——chain-coverage-audit §4-① 的盲区）。
2. **每族至少一条断言打在 mobile 允许清单之外**：430 个被拒方法中有 **249 个不在** `MOBILE_RPC_METHOD_ALLOWLIST`——scope 误映射（云会话被降级成 mobile 行）只在这些方法上现形（清单内方法会被 mobile 层放行，拒绝被静默吞掉，正是 chain-coverage-audit §4-② 的机制）。各族的清单外钉子：

   | 族 | 该族自身的清单外方法 | 备注 |
   | --- | --- | --- |
   | F3 preflight | `preflight.refreshAgents`、`preflight.detectRemoteWindowsTerminalCapabilities` | `preflight.detectAgents/check` 在清单内，断言用 refreshAgents |
   | F4 skills | **全部** `skills.*`（`skills.discover/delete/install/...` 15 个） | 最干净的钉子族 |
   | F5 集成面 | `github.listIssues/prComments/markPRReadyForReview/issue/repoUpstream/...`、`gitlab.listMRs/jobTrace/retryJob/...`、`linear.testConnection/issueCreate/...` | `github.prForBranch` 在清单内，不能当钉子 |
   | F7 session.tabs | `session.tabs.setTabProps`、`session.tabs.updatePaneLayout` | 镜像用的 `listAll/subscribeAll/subscribe` 都**在**清单内，必须补一条清单外断言 |
   | F8 worktree | `worktree.lineageList`、`worktree.persistSortOrder`、`worktree.teardownMissingTerminals` | `worktree.activate` 在清单内 |
   | 跨族兜底钉 | `repo.show`、`repo.hooksCheck`、`layout.subscribe`、`settings.updatePRBotAuthorOverride`、`aiVault.setSearchEnabled` | 任选其一做「云层拒绝确实生效」的独立负向 |

   断言方式：读宿主 `cloud-host-audit` 的 `method_denied` 记录或 RPC 回包文案，并**逐字断言云层文案** `is not available to cloud sessions`（mobile 层文案是 `is not available to mobile clients`，二者可分——这一条同时守住 L6 误映射回归）。
3. **客户端跳过类修复的正向断言必须打「零调用」**：mock/spy 传输层断言云会话下该方法 0 次发出（W7c MIN-2 的教训：SSH 跳过断言因未 stub 而不可变红）。

### 4.1 逐族回归断言
| 族 | 断言（真栈 / 单测两层） | 层级 |
| --- | --- | --- |
| F1 | 真栈 web 云会话启动 → 宿主审计**无** `ui.get` 的 method_denied；单测：云 scope 下 `uiApi.get()` 零 RPC 且返回本地态 | R1 + R3 |
| F2 | 真栈：启动后审计无 `settings.get`；改一个设置并重载 → 值保持（本地权威）；单测：`getRuntimeBackedStoredSettings` 云分支不发 `settings.get` | R1 + R3 |
| F3(a) | 真栈：持 `agent` 权限的票据调 `preflight.detectAgents` → 200 且返回的 CLI 列表非宿主全域（只含探测结果）；负向：无 `agent` 权限 → `needs the 'agent' project permission`（L2 文案钉死）；单测：`cloudMethodAccess('preflight.detectAgents')==='agent'` | R1 + R3 |
| F3(c) | 真栈：云会话 composer 打开 → 审计无 `preflight.check`；UI 显示宿主诊断不可用说明 | R1 |
| F4 | 真栈：打开 agent 会话聊天 → 审计无 `skills.discover`（或恰一条带 denial details 的拒绝且 UI 为文档型空态） | R1 |
| F5 | 真栈：激活云工作区 → 审计 `github.prForBranch` 要么零调用（短路）要么恰一条 method_denied 且 PR 区渲染占位文案；断言不得出现裸 console error | R1 |
| F6(a) | 真栈：打开属于 ticket workspace 的 agent 会话 → `nativeChat.readSession` 200 且转录内容与宿主文件一致；负向：伪造他项目 sessionId → 拒绝（`method_denied` 审计带 PATH/SCOPE 归因） | R1 |
| F6(b) | 退档时：聊天面板空态文案 + 实时流仍可达（`terminal.multiplex` 帧断言） | R1 |
| F7 | 真栈（**桌面形态**：Electron 客户端登录云项目）→ 宿主审计零 `session.tabs.*`/`runtime.clientEvents.subscribe` 的 method_denied；单测：镜像环境集过滤含云环境的用例（`use-web-session-tabs-sync` + `runtime-client-ipc-bridge` 双侧） | R1 + R3 |
| F8 | 真栈：侧栏点击第二个工作区激活 → 审计零 `worktree.activate`；延迟刷新后审计零 `worktree.lineageList`；单测：lineage 刷新对云目标返回空且不抛 | R1 + R3 |
| F9 | 真栈：云会话调 `files.browseServerDir('/etc')` → `path_denied`（L4 文案钉死，防将来被误登记录为放行）；quick open 正常回退 | R1 |

### 4.2 与 W13b / W9b 旅程的衔接
- **W13c-2（W13b 视图负向 + 点亮面清单）**：本文档 §2 的 F1–F9 就是清单的预期答案骨架；实现代理跑「点亮面清单」时按族对账——预期内已容忍（F9 全部、F1/F2 的本地回退）、新发现坏路径（F7 桌面 warn-loop、F8 activate warn、F6 聊天转录失败）→ 逐条入本清理单并按 §3 裁定派令。
- **W9b（Orca Web B 线黄金旅程）**：在 B3（自动进入工作区）与 B4（终端/文件树对等）之间插入两个断言：①启动窗口内宿主审计中 `method_denied` 计数为已知集合（预期 = 空集或 {F9 browseServerDir 按需} 之外不得新增）；②终端输入回显 + explorer 打开 README 全程**零** `not available to cloud sessions` console error。旅程产物（`evidence/journey-golden-b/`）记录审计计数，作为后续每波的回归基线。
- **W9a（桌面 A 线）**：F7/F8 的桌面断言并入 A 线「打开项目→终端→文件」旅程（桌面正是未门控面）。
- **chain-coverage-audit §5a 冒烟套件**：S1（桌面打开项目）步骤加「宿主审计零 F7/F8 拒绝」；其守卫断言 #2（「至少一个断言调用 mobile 清单外方法」）直接采用 §4.0-2 的钉子。

---

## 5. 实现切分（≤20 分钟/令，域不相交，可并行）

| 令 | 内容 | 域 | 依赖 |
| --- | --- | --- | --- |
| O1-a | F7：云环境过滤镜像订阅（session-tabs 双 installer + runtime-client-ipc-bridge 三处门 → 共享谓词）+ 双侧单测（零调用断言） | `src/renderer/src/runtime/web-session-tabs-sync/`、`hooks/ipc-events/`、`shared/runtime-environments.ts`（谓词） | 无 |
| O1-b | F8：`worktree.activate` 激活管线云分支 + lineage 桌面跳过 + 单测 | `lib/worktree-activation.ts`、`store/slices/worktrees/metadata/worktree-lineage-refresh.ts`、`app-shell/startup-remote-catalog-refresh.ts` | O1-a 的谓词（同 PR 顺序执行即可） |
| O1-c | F1+F2：web `ui.*`/`settings.*` 云会话本地短路 + 单测 | `web/preload-api/web-ui-api.ts`、`web-preferences-store.ts`、`web-settings-api.ts` | 无 |
| O1-d | F3：`preflight.detectAgents/refreshAgents` 宿主登记（权限表 + agent-scope + 探测 cwd 钉 workspaceRoot）+ L2 负向 + 真栈正例 | `src/main/cloud-platform/cloud-rpc-permission.ts`、`cloud-agent-scope.ts` + 测试 | 无（与 a/b/c 域不相交） |
| O1-e | F5+F4：云会话 PR 区/集成面/技能面短路 + 占位呈现 + 断言 | `store/github/pull-request-execution.ts`、`use-native-chat-skills.ts`、相关组件 | 无 |
| O1-f | F6：`nativeChat.readSession/subscribe` 宿主登记 + 会话归属 scope 校验（含 scope 不可证明时退 (b) 的决策记录） | `cloud-rpc-permission.ts`、`cloud-agent-scope.ts`、`native-chat-session-transport.ts` | O1-d 落地后复跑其真栈用例 |
| O1-g | 测试收口：W9b/W9a 旅程插入审计计数断言 + `cloud-admin-session.e2e`/`web-cloud-handoff-entry.e2e` 换生产方法表（chain-coverage §5b B3/C10 项） | `tests/e2e/` | O1-a…f 合入后 |
| O1-h | F9：唯一改动点=云会话 composer 隐藏「添加目录」入口（其余零改动，记录验证结论） | composer 组件 | 无 |

> 粒度校验：O1-a 是最大令（3 文件 + 2 测试），预估 ~20 分钟；其余 ≤15 分钟。O1-d 与 O1-f 都动 `cloud-rpc-permission.ts`，**必须串行**（或合并为一令），其余可并行。

---

## 附录 A · 430 个被拒方法的全集与分层策略

- 复算方式：`find src/main/runtime/rpc -name "*.ts" ! -name "*.test.ts" | xargs grep -hoE "^\s*name: '[a-zA-Z0-9_.]+'" | sed "s/.*name: '//;s/'//" | sort -u` → 674；对每个名字跑 `cloudMethodAccess` 等价判定 → 拒绝 430 / 放行 244（其中 249 个同时不在 mobile 允许清单）。
- 启动链外的被拒面按「宿主级资产/宿主窗面/客户端形态」三类归档，通用策略 = (c) 保持拒绝；仅当某方法成为云会话点亮面的必要输入时才按 §3 通用原则 2 评估 (a)：
  - 宿主级资产：`accounts.*`、`ssh.*`、`projectGroup.*`、`folderWorkspace.*`、`repo.*`（除 `repo.add`）、`project.list/update`、`projectHostSetup.*`、`managedServer.*`、`updater.*`、`pairing.*`、`plugins.*`、`hostedReview.*`、`jira.*`、`linear.*`、`github.*`、`gitlab.*`、`skills.*`（除 F4 已定）、`automation.*`、`orcad.migration.*`、`workspacePorts.*`、`artifacts.*`、`host.*`（platform/wsl/gitBash/pwsh——宿主形态事实）。
  - 宿主窗面/全景：`session.tabs.*`（F7 已定）、`worktree.ps/sleep/activate/set/lineageList/...`（F8 已定）、`computer.*`、`emulator.*`、`orchestration.*`（跨机编排面）、`agentTeams.*`。
  - 客户端形态/移动专用：`ui.*`（F1）、`mobileWeb.bundle.*`、`clipboard.*`、`speech.*`、`notifications.*`、`stats.summary`、`diagnostics.memory`、`markdown.readTab/saveTab`、`agentSessionAttachment.*`、`aiVault.*`（F6 已定）。

## 附录 B · 触发矩阵（谁在哪条形态上会撞）

| 族 | 桌面客户端（云项目） | Orca Web（云会话） | 备注 |
| --- | --- | --- | --- |
| F1 ui.* | 不触发（本地 IPC） | **boot 即触发** | W7c MIN-4 |
| F2 settings.* | 不触发 | **boot 即触发** | 每次设置写再触发 update |
| F3 preflight.* | **触发**（空 workspace 默认 agent、composer） | **触发**（同左，经 web API `.catch`） | W13b 点亮后首屏即可达 |
| F4 skills.* | **触发**（agent 聊天面板） | **触发** | |
| F5 集成面 | **触发**（激活→GitHub 刷新） | **触发** | |
| F6 aiVault/nativeChat | 触发（右侧栏/聊天） | **触发（点亮面核心）** | |
| F7 session.tabs/clientEvents | **触发且未门控（warn-loop）** | 已门控（W7c） | 本次复核主发现 |
| F8 worktree.activate/lineage/set | **触发且未门控** | activate 已被 bootstrap 绕开，但用户后续激活仍触发 | |
| F9 路径守卫 | 按需 | 按需 | 设计意图内 |
