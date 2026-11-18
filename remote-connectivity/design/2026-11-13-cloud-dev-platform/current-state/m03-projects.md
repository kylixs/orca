# M3 项目（现状）

> 基线提交：`664a91e0322`（2026-11-16）｜来源：`cloud-platform/apps/web/app.js`（列表/登记/详情/权限卡片/入口）、`cloud-platform/apps/api/src/server.ts`（projects 端点）代码阅读 + 既有套件。
> 本次未启动 18787（探测 `000`），界面以代码为准。

## 1. 页面/界面布局

**项目列表（我的项目，`#/projects`）**

- 页头：标题「我的项目」、说明「仅展示你有『打开项目』权限的项目」；右侧「登记项目」（管理员）与「刷新」。
- 工具栏：一个搜索框（项目名、仓库或主机）。
- 表格：列 `项目 / 仓库 / 主机 / 权限 / 下载策略 / 操作`。
  - 项目列：名称 +（归档徽标）、下一行等宽路径；`failed` 且有 `provisioningError` 时追加行内「准备失败：<reason>」（`[data-provisioning-error]`，D22）。
  - 主机列：主机名 + 主机状态徽标（维护中 / 主机离线）。
  - 权限列：ACL 权限位文本；管理员无授权行显示「管理员可见（未授权）」；主机只读授权追加「（主机只读上限）」。
  - 下载策略列：生效值徽标 `允许` / `禁止`。
  - 操作列：`打开`、`授权并打开`（仅管理员且无 open）、`详情`（仅管理员）、`Orca Web`（有 open 时）。
- 无分页；空态「没有匹配的项目」。

**登记项目弹框（`.dialog`，标题「登记项目」）**

- 顶部行内错误区（兜底/未映射错误）。
- 字段：项目名称、项目 Key（占位含规则；失焦即校）、目标主机下拉（已吊销主机不出现；离线/维护标注）、目标路径（占位「主机上的绝对路径」；选中主机有项目根时显示「主机项目根：…」提示）、仓库地址（可选，留空=登记即就绪）、默认分支（可选，留空用远端默认分支）。
- 每字段下方独立行内错误行；底部主按钮「登记」。
- 仓库地址校验（U136①→U141→U142）：接受 http(s)/ssh/git/`file://`、本地绝对路径、`user@host:path` 形式 SCP-like；拒绝裸串、UNC（`\\server\share` 与 `//server/share`）、ftp、`ext::`、控制字符；平台与宿主共用同一接受/拒绝矩阵（`repo-url-acceptance-cases.ts`），历史数据读取不重校验。

**项目详情弹框（管理员，`.dialog.wide`，标题「项目详情」）**

- 顶部可选黄条：「未能刷新项目信息，以下为最近一次加载的数据。」
- 页签：`信息` / `权限`。
- 信息页三组：
  1. 基本信息：项目名称、项目 Key、项目 ID（带复制）、创建者、创建时间（本地化 + 相对）、项目状态徽标（准备中/就绪/准备失败/已归档）、失败原因（仅 `failed` 且有 `provisioningError`）。
  2. 运行配置：主机名 + 主机 ID、宿主状态徽标（在线/离线/维护中 + 维护原因）、项目路径（复制）、仓库地址（复制；未配置显示「未配置仓库」）、默认分支。
  3. 授权与策略：我的权限（徽标列表）、直接授权（用户名/组 + 项数）、下载策略（禁止/允许 + 「项目覆盖」/「跟随全局」）、独立页链接（有 `sessionPageUrl` 时）。
- 权限页：三张卡片——`查看`（open + file:read，可编辑）、`控制`（terminal + agent + file:write + browser + download，可编辑）、`管理`（`主机推导 · 只读`，展示在主机级获得 view 的主体，`全权（来源）`/`只读（上限）`徽标，不可增删）。另有「其他位组合」卡（仅当存在不被任何卡片认领的授权行时出现，可移除）。
- 底部：主按钮「打开项目」（不可打开时 disabled 且 title 给原因）、「关闭」。

**工作区入口（同页覆盖层）**

- 打开不新开标签：全屏 `.workspace-overlay`，顶栏含「← 返回」、项目名、默认分支、路由/延迟（就绪后）、未保存文件数、「在新标签打开 Orca Web」、「结束工作区」（宿主声明支持 end 时）、「关闭」；主体为宿主 `cloud-admin.html` iframe。内容细节归 M9/M10。

## 2. 菜单与入口（权限门槛）

| 入口         | 位置                     | 门槛                                                                                                                    |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 我的项目     | 侧栏                     | 已登录；`GET /v1/projects` 仅返回 ACL 内项目（管理员全部）                                                              |
| 登记项目     | 列表页头                 | `platform:admin`（接口 403 + denied 审计）                                                                              |
| 详情         | 行内 / 工作台行内        | `platform:admin`                                                                                                        |
| 打开         | 行内 / 卡片 / 详情主按钮 | 项目 `open` + 未归档 + 主机在线且非维护；管理员无授权时可先「授权并打开」                                               |
| 授权并打开   | 行内（管理员无 open）    | `platform:admin`；确认后 PUT 自授 5 位                                                                                  |
| Orca Web     | 行内（有 open）          | 项目 `open` + 主机在线且非维护                                                                                          |
| 权限页签增删 | 详情弹框                 | 页面入口 admin-only；`PUT /v1/projects/:id/grants` 允许 admin 或 `project:owner` 角色（当前角色集无该角色，等价 admin） |
| 归档 / 恢复  | **控制台无入口**         | 仅 API：`POST /v1/projects/:id/archive                                                                                  | restore`；创建者自助或管理员 |

## 3. 操作清单

| #   | 触发面                           | 结果                                                                                                                                                                      | 弹窗/确认                                                     | 失败态                                                                               | 权限门槛                            |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| C1  | 进入「我的项目」                 | `GET /v1/projects` + `GET /v1/policies/download`，按生效下载策略渲染列表                                                                                                  | 无                                                            | 加载失败→内容区「加载失败」+重试                                                     | 已登录                              |
| C2  | 搜索框输入                       | 客户端过滤（名称/仓库/主机包含，大小写不敏感），即时重绘                                                                                                                  | 无                                                            | 无匹配→空态行                                                                        | 已登录                              |
| C3  | 「刷新」                         | `location.reload()`                                                                                                                                                       | 无                                                            | —                                                                                    | 已登录                              |
| C4  | 「登记项目」（管理员）           | 拉 `GET /v1/hosts`（排除已吊销）后打开弹框                                                                                                                                | 弹框                                                          | 拉取失败→toast「打开登记弹层失败：…」                                                | `platform:admin`                    |
| C5  | 项目 Key 失焦                    | 与提交同一份规则即时校验                                                                                                                                                  | 无                                                            | 非法→字段标红 + 行内规则文案；合法→清错                                              | 同上                                |
| C6  | 目标主机切换                     | 清空已填目标路径（避免跨主机路径误登记）；刷新「主机项目根」提示                                                                                                          | 无                                                            | —                                                                                    | 同上                                |
| C7  | 提交（客户端校验失败）           | 不请求；所有错误字段标红并列出，焦点到首个错误                                                                                                                            | 无                                                            | 名称空/超 200、Key 长度/字符集/尾点、主机未选、路径非绝对/含 `..`/尾分隔符           | 同上                                |
| C8  | 提交成功（无 repoUrl）           | `POST /v1/projects` → 弹框关闭，toast「项目已登记…授权请在项目详情的『权限』页签中配置。」→ 重绘列表；项目状态 ready                                                      | 无                                                            | —                                                                                    | 同上                                |
| C9  | 提交成功（有 repoUrl）           | 同上，toast 追加「克隆中，就绪后可打开」；状态 provisioning，等待宿主克隆回报转 ready                                                                                     | 无                                                            | 克隆失败由心跳回报 `provisioningError`；列表/卡片内联「准备失败：<reason>」（`[data-provisioning-error]`，D22），详情显示失败原因 | 同上                                |
| C10 | 提交（服务端字段错误）           | 按错误码落字段：`HOST_NOT_FOUND`→主机、`PROJECT_EXISTS`→Key、`PROJECT_PATH_TAKEN`/`PROJECT_PATH_INVALID`→路径、`REPO_URL_INVALID`→仓库、`BRANCH_INVALID`→分支；其余落顶部 | 无                                                            | 弹框不关、输入保留、按钮恢复；`HOST_OFFLINE`/`PROJECT_NAME_INVALID` 等未映射码走顶部 | 同上                                |
| C11 | 行内「打开」                     | `POST /v1/projects/:id/web-handoff {surface:'admin'}` → 同页 iframe 覆盖层；老平台返回非 `cloud-admin.html` 时新标签打开并 toast「当前平台版本不支持内嵌工作区…」         | 脏文件关闭确认；结束工作区确认                                | 签发失败→覆盖层失败态（重试/新标签）；20 秒未就绪→超时态，最多重试 2 次              | open + 主机在线/非维护 + 未归档     |
| C12 | 「授权并打开」                   | 确认框列出 5 个权限位并警告断开全部云会话；确认→`PUT grants` 自授→toast「已授权，正在打开…」→打开                                                                         | 确认框                                                        | toast「授权失败：…」，不打开                                                         | `platform:admin` 且无 open          |
| C13 | 行内「详情」                     | 弹框先渲染缓存行，再并发刷新 `GET /projects/:id`、grants、下载策略、主机 grants；主按钮随刷新后的可打开性更新                                                             | 弹框                                                          | 任一刷新失败不阻塞弹框；项目 GET 失败显示黄条；grants 失败显示「未能读取直接授权」   | `platform:admin`                    |
| C14 | 详情页签切换                     | 纯视图态切换，不改 URL、不影响 Escape/关闭                                                                                                                                | 无                                                            | —                                                                                    | 同上                                |
| C15 | 详情「复制」按钮（ID/路径/仓库） | 写剪贴板，toast「已复制」                                                                                                                                                 | 无                                                            | 剪贴板 API 不可用时静默（仍 toast）                                                  | 同上                                |
| C16 | 权限页「添加」                   | 组建/用户切换 datalist；添加=把卡片位并集进该主体整行，`PUT grants` 整行替换；成功后 toast 级别、清空输入、重绘卡片                                                       | 主体已有行→「覆盖现有授权」确认（显示级别变化与会话断开提示） | toast「授予失败：…」；输入保留；请求期间卡片控件冻结；未知组/非法位显示平台文案      | 同上（接口 admin 或 project:owner） |
| C17 | 权限页芯片「✕」移除              | 从该行减去卡片位并 `PUT`；仍有剩余位→toast 级别变化并重绘                                                                                                                 | 剩余为空→「移除全部授权」确认（用户/组不同爆炸半径文案）      | toast「移除失败：…」；控件冻结后恢复                                                 | 同上                                |
| C18 | 详情「打开项目」                 | 弹框关闭并启动同页覆盖层（同 C11）                                                                                                                                        | 无                                                            | 不可打开时按钮 disabled + title                                                      | 同 C11                              |
| C19 | 详情关闭                         | Escape / 背景点击 / 「关闭」；焦点回到「详情」按钮                                                                                                                        | 无                                                            | —                                                                                    | 同上                                |
| C20 | 行内「Orca Web」                 | `POST web-handoff`（web surface）→ 新标签；入口按 open 权限渲染                                                                                                           | 无                                                            | toast「打开失败：…」；离线/维护 disabled + 原因                                      | open + 主机在线/非维护              |
| C21 | 归档 / 恢复                      | **控制台不可达**；仅 API。归档后项目从 `/v1/projects` 消失（管理员可 `includeArchived=1` 取回），详情 GET 归档项目返回 404；归档撤销该项目全部凭证并释放 key/路径         | API 无确认 UI                                                 | API 非创建者/非管理员返回 404（不泄漏存在性）                                        | 创建者自助或 admin                  |

## 4. 数据来源

| 面           | 来源                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表         | `GET /v1/projects`（活跃 + ACL；`includeArchived=1` 仅管理员）、`GET /v1/policies/download`                                                             |
| 登记         | `GET /v1/hosts`（含 revokedAt/projectsRoot/online/status）、`POST /v1/projects`                                                                         |
| 详情         | `GET /v1/projects/:id`、`GET /v1/projects/:id/grants`、`GET /v1/policies/download`、`GET /v1/hosts/:id/grants`（推导卡）、`GET /v1/directory`（选择器） |
| 权限写入     | `PUT /v1/projects/:id/grants`（整行替换；用户/组名解析为内部 id）                                                                                       |
| 打开         | `POST /v1/projects/:id/web-handoff`；iframe 消息 `ready/dirty/closed/suspended/ended`（`source='orca-cloud-admin'`，校验 origin 与 source window）      |
| 归档/恢复    | `POST /v1/projects/:id/archive                                                                                                                          | restore`（仅 API） |
| 下载策略覆盖 | `PUT /v1/projects/:id/policy`（平台设置页，M8）                                                                                                         |
| 更新（仅 API） | `PUT /v1/projects/:id` body 至少含 `repoUrl` 或 `defaultBranch`（显式 `null` 合法）；缺失 → 400 `PROJECT_UPDATE_INVALID`；`path`/`hostId` → 400 `PROJECT_FIELD_IMMUTABLE`（先于必填判定）；校验在认证/授权/`auditAllowsMutations` 之后（`server.ts:4693-4712`，`097025df563`） |

- 请求体上限：项目创建/自助/更新按档 3，`PUT grants`/`policy` 按档 2；拒绝分支仍 403 + denied 审计，见 M1「U250 body 分档」。
- 项目路径契约上限：`PROJECT_PATH_MAX_CHARS = 4096` 单一定义在 `project-self-service.ts:17`，由 `server.ts:16` 导入（U256 `552ccd93177`）；创建时 `>4096` → 400 `PROJECT_PATH_INVALID` 并记 `project_create` denied 审计（`server.ts:4655-4668`，`dc9c6e938ad`）。Windows 扩展长路径不再依赖 body 上限兜底。
- 自助创建派生路径（U256）：`projectsRoot + 目录名` 超 4096 → 400 `PROJECT_PATH_INVALID`，在任何项目行创建前拒绝、不落库（`server.ts:4821-4827`，判定 `project-self-service.ts:157-164`）；`PROJECT_DIR_NAME_MAX_BYTES = 255`（UTF-8 字节），`parseProjectDirs` 静默丢弃超限目录名以保住 200 × 255 B 前提（`project-self-service.ts:20,58-66`）。

## 5. 已知缺陷（台账）

- 🟢 U18：管理员登记对 key/name 不设防（服务端已补 `PROJECT_KEY_INVALID` / `PROJECT_NAME_INVALID`）。
- 🟢 U19：登记不校验目标主机在线（现两路径均 409 `HOST_OFFLINE`）。
- 🟢 U25：默认分支校验与宿主不一致（现两端同款 git-ref 规则）。
- 🟢 U20 / U37 / U44：provisioning 门禁、repo-ful 克隆死锁、克隆期 UX（现状：创建即 `provisioning`，心跳下行指派克隆，回报后 ready）。
- 🟢 U40 / AA5：管理员无授权打不开项目 → 自授入口。
- 🟢 U46：详情=弹框、打开=同页覆盖层、Orca Web=新标签。
- 🟢 U53③：归档项目混入在营视图（现列表默认排除；`R5-②` 已回归）。
- 🟢 U62：授权 subjectType/权限位/拒绝审计族打磨。
- 🟢 U65 / U67 / U67b：主机/项目授权语义与「详情弹框权限 tab 三卡片」已实现——主机 tab 位置即权限（`hostRoleOf`，主体只出现在唯一最高卡、chip 无级别徽标、移除即整行）；项目 tab 保留查看/控制共享行位并集 + 管理主机推导只读卡。
- 🟢 U23/U24：自建项目已存在 git 目录/并发 open（自助建项目路径，控制台未暴露）。
- 🟢 U79：主机中继绑定不可见（影响项目所能看到的主机信息，联动 M4）。

## 6. 测试覆盖

- `cloud-platform/test/e2e/web-project-registration.e2e.test.ts`：M120a-1…9（入口权限、客户端拦截零请求、成功/克隆中、重复 Key/路径字段落点、审计、兜底映射、Key 失焦）。
- `cloud-platform/test/e2e/web-project-detail.e2e.test.ts`：W46-D1…D6（弹框唯一 GET/零写、字段逐项、无入口/离线维护、createdBy 下发、同页覆盖层、Escape 焦点）。
- `cloud-platform/test/e2e/web-project-entry.e2e.test.ts`：管理员/开发者入口矩阵、维护与离线置灰、独立页链接。
- `cloud-platform/test/e2e/web-admin-self-grant.e2e.test.ts`：AA5-1…4（自授确认、恰好一次 PUT、取消零请求、已授权直接 handoff、非 admin 无入口）。
- `cloud-platform/test/e2e/web-grant-subject-picker.e2e.test.ts`：AA4-1…3（目录 datalist、未知组报错保留输入、非 admin 零目录请求）。
- `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts`：M116-QA-010（未授权管理员权限列）、007（三入口禁用）、R5-②（归档）、R5-③（覆盖确认）、W2-M-1/2（授予失败/已删除用户）。
- `cloud-platform/test/e2e/u67-role-authz.e2e.test.ts`、`u62-authz-polish.e2e.test.ts`：授权矩阵与打磨项。
- `cloud-platform/test/e2e/project-registration-validation.e2e.test.ts`、`project-branch-validation.e2e.test.ts`、`project-update.e2e.test.ts`、`project-connect-readiness.e2e.test.ts`、`project-archive.e2e.test.ts`：服务端校验/更新/就绪门禁/归档恢复。
- `cloud-platform/test/e2e/self-service-projects.e2e.test.ts`、`self-service-project-dir.e2e.test.ts`：自助建项目（控制台无入口）。
- `cloud-platform/test/e2e/u46-1-platform-contract.e2e.test.ts`、`u46-3-overlay.e2e.test.ts`：handoff 契约与覆盖层。
- 证据目录参考：`cloud-platform/evidence/aa5-self-grant/`、`aa6-host-drawer/`、`aa4-subject-picker/`。

## 7. 未覆盖 / 存疑

- **创建向导无目录选择器（U116②，2026-11-18 裁定不立项）**：目标路径维持自由文本（仅主机切换时清空 + 显示项目根提示），不加目录浏览/选择控件；自助创建路径已有目录清单（`projectDirs`），管理台登记无需再加一层选择器。
- **归档/恢复无控制台 UI 与 e2e 页面用例**（`project-archive.e2e` 只测 API）；用户无法从管理台归档或恢复。
- 项目详情 `刷新失败` 黄条、独立页链接、复制按钮无专门 e2e。
- 项目权限 tab 的「控制」卡添加/移除无专门 e2e（AA4/AA6 主要在主机侧与选择器；`R5-③` 覆盖重复添加确认）。
- 「管理（主机推导·只读）」卡的推导内容无 e2e 断言。
- 管理员登记后的 `provisioning → ready` 全链路 UI（状态徽标变化、失败原因展示）无浏览器 e2e（服务端 readiness 有套件）。
- `project:owner` 授权写入口在角色体系中不可达（用户页只有普通/审计/管理员），实际等价 admin-only；U116④ 裁定不立项（角色集无此值、旁路不可达）。
