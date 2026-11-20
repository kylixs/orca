# 移动端 HTML 打开方式：任务拆分

> 状态：设计 review-04 APPROVED_WITH_MINORS（6 MINOR 已处理，2026-11-10）
> 单一动作模型：文件浏览 `mobile-file-actions.ts` 是唯一来源；HTML 用模式 Preview 取代通用 Preview，并追加 Source。

## 1. 模式、偏好与路由

| ID     | 任务                                                                                                                                      | 文件/模块                                                                                                                               | 依赖         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| HT-T1  | `orca:mobileHtmlOpenMode` 枚举校验/回退 `ask`；读写失败提示                                                                               | `mobile/src/storage/preferences.ts`                                                                                                     | —            |
| HT-T2  | `mode` 进入路由全链路：类型、导航、app `.tsx`/`.web.tsx` 参数解析、normalize、shell params                                                | `mobile-file-preview-route.ts`、`mobile/app/h/[hostId]/files/preview/[worktreeId].tsx`、`.web.tsx`、`mobile-file-preview-navigation.ts` | —            |
| HT-T3  | 预览页持有 page-local mode；优先级 sourceOnly/truncated > route.mode > line/column > 偏好 > ask；返回不写偏好                             | `MobileFilePreviewScreen.tsx`                                                                                                           | HT-T1、HT-T2 |
| HT-T5  | Browser 设置页 `HTML open mode: Ask / Preview / Source`：复用行 + PickerModal（唯一恢复入口）                                             | `settings/browser-settings-screen.tsx`                                                                                                  | HT-T1        |
| HT-U11 | OTA/参数链：文件预览强制 native；mode 不丢失；不依赖 FB-U7 条件                                                                           | `shell-switch-decision.ts`、路由文件                                                                                                    | HT-T2        |
| HT-U12 | `source=terminalArtifact`/truncated 强制 source；`htmlRenderable`/`sourceOnly`/`truncatedNote` 传入 body；terminal artifact 可编辑仍 Save | 预览路由/body                                                                                                                           | HT-T3、HT-V1 |

## 2. 动作与菜单

| ID     | 任务                                                                                                                                                                                                        | 文件/模块                                             | 依赖                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| HT-U1  | 只导出 HTML 模式动作描述与 `availableHtmlOpenActions({source,previewDisabled,readFailed})`；不碰保存/打开/复制                                                                                              | `mobile-file-open-mode-actions.ts`（新）              | —                                  |
| HT-U2  | `MobileFileOpenModeSheet`（ActionSheetModal）：Preview/Source、remember（仅模式生效）                                                                                                                       | `mobile/src/files/MobileFileOpenModeSheet.tsx`（新）  | HT-U1                              |
| HT-U3  | HTML 第二行工具栏 Preview/Source；header 溢出由 FB-U3 提供，不新增入口                                                                                                                                      | `MobileFilePreviewScreen.tsx`                         | FB-U3、HT-T3、HT-V1、HT-U2、HT-U6  |
| HT-U4  | 扩展文件浏览 `buildFileActions(target, {context,htmlOpenMode,capabilities})`：HTML 用模式 Preview 取代通用 Preview，Source 紧随；唯一顺序 Preview、Source、Save、Open with、Copy content、Copy path、Cancel | `mobile-file-actions.ts`、`MobileFileActionSheet.tsx` | FB-T2、FB-U1、FB-U3、FB-U10、HT-U1 |
| HT-U5  | 自动弹层：worktree HTML 固定两个模式；line/column 与 terminal artifact 直开                                                                                                                                 | `MobileFileExplorerPanel.previewFile`                 | HT-T2、HT-T3、HT-U2、HT-U4         |
| HT-U13 | 溢出 sheet 的焦点/back/outside-tap；依赖 FB-U3 宿主                                                                                                                                                         | 预览页                                                | FB-U3、HT-U3                       |
| HT-U14 | a11y：44×44、tab/switch `accessibilityState`、sheet 焦点                                                                                                                                                    | 组件                                                  | HT-U13                             |
| HT-U15 | 与文件浏览交叉验收：单一 builder、动作数组完全一致、无重复                                                                                                                                                  | `mobile-file-actions` 测试                            | HT-U4、FB-U10                      |
| HT-U16 | Copy content：按需读取 ≤512 KB，截断提示；长按/溢出不写偏好                                                                                                                                                 | 动作/预览                                             | HT-U4                              |

## 3. 渲染与导航

| ID    | 任务                                                                                                                                                                        | 文件/模块                           | 依赖         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------ |
| HT-U6 | 抽 `MobileHtmlPreviewFrame({ html, mode, showToolbar?, onExternalLink, onBlockedScheme? })`；会话页薄包装；不持有 mode；**不加** `textInteractionEnabled`（由 FB-U11 追加） | `MobileHtmlPreview.tsx`、`.web.tsx` | —            |
| HT-U7 | `html-preview-scheme.ts` 白名单 + 顶层/子帧导航策略；不修改 `openExternalLink` 契约                                                                                         | 新模块、Frame                       | HT-U6        |
| HT-U8 | `findRelativeHtmlAssetRefs` 纯函数 + 检测后提示（规则见 design 8.6）                                                                                                        | `html-relative-assets.ts`（新）     | —            |
| HT-U9 | >512 KB：源码专用 `truncatedNote`（“Showing first 512 KB”）、Preview 禁用/英文文案；511/512/513 KB；不改 Markdown 文案                                                      | 预览加载/body                       | HT-U6        |
| HT-V1 | 文件预览 HTML 渲染 body 接 Frame                                                                                                                                            | `MobileFilePreviewBody.tsx`         | HT-U6、HT-U9 |
| HT-V2 | 相对资源提示 UI（最多 3 个引用，精确文案）                                                                                                                                  | 渲染 body                           | HT-U8、HT-V1 |
| HT-V4 | 导航拒绝：顶层 file/intent/javascript/自定义 scheme；子帧危险 scheme 拒绝但不外开；`onBlockedScheme` toast；不注入桥                                                        | Frame                               | HT-U7        |

## 4. 测试

| ID    | 任务                                                                                    | 依赖                 |
| ----- | --------------------------------------------------------------------------------------- | -------------------- |
| HT-Q1 | 偏好/损坏回退/设置恢复/失败写回                                                         | HT-T1/T5             |
| HT-Q2 | 动作可用性、自动弹层、单一 builder、动作顺序与无重复                                    | HT-U1/U2/U4/U5/U15   |
| HT-Q3 | 模式优先级/路由/返回/OTA/terminal artifact 可编辑与只读                                 | HT-T2/T3/U11/U12     |
| HT-Q4 | 渲染/导航：自包含、相对资源、外链白名单、meta refresh、iframe、web sandbox、512 KB 边界 | HT-U6..U9、V1..V4    |
| HT-Q5 | 回归：会话 HTML、Markdown、文件菜单、搜索、Save 不回归                                  | 全部                 |
| HT-Q6 | 组件：长按/溢出/remember 语义/a11y/键盘/返回                                            | HT-U2/U3/U13/U14/U16 |
| HT-Q7 | 交叉：文件浏览 + HTML 同时存在，动作无重复、顺序固定                                    | HT-U4/U15            |
| HT-Q8 | 真机/模拟器报告与证据（Android/iOS 必过）                                               | 全部                 |

## 5. 合并顺序

1. FB 核心：FB-T2/T3/T10、FB-U1/U3/U10（文件动作/预览宿主）。
2. HTML：HT-T1/T2/T3/T5 → HT-U1/U2/U4/U5 → HT-U6/U7/U8/U9 → V1/V2/V4 → U3 → U11/U12/U13/U14/U16.
3. 测试 Q1..Q8，其中 HT-U15/HT-Q7 与 Q2 同批；最后 FB-U11 文字选择（唯一 owner，不再有 HT-U17）。

## 6. Review-04 MINOR 处理决定

| 条目                     | 决定                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 旧正文值                 | 已清理偏好键、自动弹层计数、header 切换、动作顺序、追加/取代语义、512KB Copy content、导航锁、任务状态                                                 |
| no-app 文案              | 采用 “No app available for this file type. Use Save to phone instead.”；README 已收录，C14 已同步                                                      |
| B12 名称                 | 改为 “>512 KB（truncated）菜单”                                                                                                                        |
| availableHtmlOpenActions | 唯一签名 `{source,previewDisabled,readFailed}`；truncated 只隐藏 Preview；readFailed 隐藏 Preview/Source/Copy content；terminal artifact 只提供 Source |
| 合并顺序                 | 在 V1 后加入 HT-U3；HT-U15/HT-Q7 与 Q2 同批                                                                                                            |
| C18 Android 子帧         | 限定顶帧 + iOS 子帧危险 scheme；Android 只断言不外开、不离开预览                                                                                       |
| 原型/README              | 无需再改；动作数组/文案已同步                                                                                                                          |

## 7. 完成定义

- 本文任务全部完成；Q1..Q8 通过并归档证据。
- 设计/代码/测试独立评审通过。
- 不改变会话 HTML 预览、Markdown 切换、文件菜单、终端产物 Save 的既有行为。
- 不新增“在 Orca 浏览器打开”动作。

## 8. 修复 01（2026-11-10，独立测试评审后）

| ID    | 任务                                                            | 状态                               |
| ----- | --------------------------------------------------------------- | ---------------------------------- |
| HT-F1 | Android 注入式 scheme 拦截 + 固定哨兵通道；原生回调不变         | 完成（fix-05 复审 APPROVED）       |
| HT-F2 | meta refresh 非白名单目标移除并延迟 toast                       | 完成（含属性后设/重挂/0 延迟）     |
| HT-F3 | 拦截脚本真实 DOM 事件测试、Frame 契约测试、Android 实机点击复验 | 完成（Android 通过；iOS 环境阻塞） |
| HT-F4 | 设计 §9 / 测试 C10/C11b/C12/C19 修正                            | 完成                               |
| HT-F5 | 子帧策略、isTopFrame、动态 about:blank、srcdoc 警告、质量门禁   | 完成（fix-05 复审 APPROVED）       |

## 9. 最终验收（2026-11-10）

- 修复经 5 轮独立代码评审，最终 `fix-code-review-05.md`：APPROVED（0 BLOCKER / 0 MAJOR / 2 MINOR 文档项）。
- `regression-01.md`：Android HTML/安全 18 项完整 PASS，包括 javascript/file/intent/tel/custom 拦截、静态/后设/重挂/0 秒 meta refresh、子帧 https/mailto/tel、动态 about:blank、formaction、https 外开、fragment、data；全量自动化 10,687/10,696。
- 未覆盖项（不计 PASS）：iOS（Xcode 26 阻塞）、物理设备、WebView <89 fallback、跨源/CSP 帧等已记录残余。
- 结论：Android/模拟器范围 FINAL_ACCEPT。
