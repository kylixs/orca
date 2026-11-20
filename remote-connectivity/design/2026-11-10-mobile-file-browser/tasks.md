# 移动端文件浏览：任务拆分

> 状态：设计 review-05 APPROVED_WITH_MINORS（0/0/3，MINOR 已处理，2026-11-10）
> 优先级：P0 = 阻塞主流程；P1 = 本需求必须；P2 = 后续

## 1. 基础设施与动作模型

| ID     | 任务                                                                                                                              | 文件/模块                                       | 依赖          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------- |
| FB-T1  | 引入 `expo-sharing` + `expo-intent-launcher`；prebuild/dev client/版本号/发布验证                                                 | `mobile/package.json`、app config               | —             |
| FB-T2  | 唯一文件动作构造器 `buildFileActions(target, {context, htmlOpenMode?, capabilities})`；动作顺序固定                               | `mobile/src/files/mobile-file-actions.ts`（新） | —             |
| FB-T3  | prepare 管线：stat → chunk → cache → 校验 → 进度/取消；不做续传                                                                   | `mobile-file-prepare.ts`（新）                  | —             |
| FB-T4  | 分享封装（iOS Save to Files/share；Android share fallback）                                                                       | `platform/share-file.ts`（新）                  | FB-T1         |
| FB-T4A | 能力探测：`requireOptionalNativeModule`/动态 import 探测 ExpoSharing/Intent/SAF/`File.contentUri`；旧二进制不崩溃、隐藏 Save/Open | `file-action-capabilities.ts`（新）             | FB-T1         |
| FB-T4B | 终端产物 prepare：文本 ≤512 KB（>512KB 提示 too large，仅 Copy path）、图片 ~3 MB、grant 刷新                                     | `mobile-terminal-artifact-prepare.ts`（新）     | FB-T3         |
| FB-T5  | Android SAF 保存 ≤16 MB：选目录/重名/取消/权限撤销                                                                                | `mobile-file-save.ts`（新）                     | FB-T3         |
| FB-T6  | Android ACTION_VIEW：content URI + read 权限；无 Activity 回退分享                                                                | `platform/open-file.ts`（新）                   | FB-T1         |
| FB-T7  | iOS UTI/iPad anchor；Save to Files                                                                                                | `platform/share-file.ts`                        | FB-T1         |
| FB-T8  | 缓存：唯一目录、24h 保留、LRU 512MB、启动孤儿清理、设置页 Clear                                                                   | `mobile-file-download-cache.ts`（新）           | FB-T3         |
| FB-T9  | `safeLocalFileName` + MIME/UTI 表（含代码文件 text/plain）                                                                        | `file-download-naming.ts`（新）                 | —             |
| FB-T10 | `FileActionTarget` 联合类型（含终端产物全字段）                                                                                   | `mobile-file-actions.ts`、预览路由              | FB-T2         |
| FB-T11 | 新二进制商店构建/版本号/回滚开关；OTA 旧二进制矩阵验证                                                                            | 发布配置                                        | FB-T1、FB-T4A |

## 2. 文件浏览器 / 预览 UI

| ID     | 任务                                                                                                                        | 文件/模块                                     | 依赖                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| FB-U1  | 行 `onLongPress` + 行尾 `…` + 长按/点击互斥                                                                                 | 行组件、面板                                  | FB-T2                                                 |
| FB-U2  | `MobileFileActionSheet`：Preview/Save to phone/Open with/Copy content/Copy path/Cancel；无 Download                         | `MobileFileActionSheet.tsx`（新）             | FB-T2                                                 |
| FB-U3  | 预览页头部唯一溢出 `…`；终端产物页仅 dirty 可编辑文本渲染 Save                                                              | `MobileFilePreviewScreen.tsx`                 | FB-T2                                                 |
| FB-U4  | 列表/预览共享进度、取消、重试、失败状态                                                                                     | `MobileFileDownloadProgress.tsx`（新）或 hook | FB-T3                                                 |
| FB-U5  | Markdown `textSelectionMode: 'chat-transcript'                                                                              | 'document'`；Android document 可选            | `MobileMarkdown.tsx`、`MobileFileMarkdownPreview.tsx` | —   |
| FB-U6  | Copy content 按需读取 ≤512 KB + 截断提示                                                                                    | 预览/菜单                                     | FB-T2                                                 |
| FB-U7  | 文件浏览/预览路由恒 native；旧二进制动作降级提示                                                                            | `shell-switch-decision.ts`、路由              | FB-T4A                                                |
| FB-U8  | `previewDisabled`/`rowDisabled` 拆分；二进制行可长按                                                                        | 行组件                                        | FB-T2                                                 |
| FB-U9  | 单飞 registry/context；同一 target 只一个 prepare；跨页共享                                                                 | `use-mobile-file-actions.ts`                  | FB-T3                                                 |
| FB-U10 | 触觉、44×44/hitSlop、读屏标签                                                                                               | 行/菜单                                       | FB-U1                                                 |
| FB-U11 | HTML 渲染文字选择：在 `MobileHtmlPreviewFrame` 追加 `textInteractionEnabled` 与链接冲突；依赖 HT-U6/HT-V1，禁止并行改 Frame | `MobileHtmlPreviewFrame`                      | HT-U6、HT-V1                                          |
| FB-U12 | 读取失败缓存：模块级 registry/context 跨预览/面板共享；行徽标 + Retry；成功清除，重连只清断线                               | `file-read-failures.ts`（新）、面板/行        | FB-U1                                                 |
| FB-U13 | 保存结果页（路径 + SHA-256 + 24h 提示）+ 组件测试                                                                           | 面板/预览                                     | FB-T8                                                 |

## 3. 搜索与过滤

| ID    | 任务                                                                                                                                                  | 文件/模块                             | 依赖         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------ |
| FB-S1 | 搜索 hook：120ms 防抖、limit ≤32、缓存                                                                                                                | `use-mobile-file-search.ts`（新）     | —            |
| FB-S2 | 常驻搜索框 + 结果扁平列表                                                                                                                             | `MobileFileSearchBar.tsx`（新）、面板 | FB-S1        |
| FB-S3 | 分类 All/Code/Docs/Media/Images/Other；PDF 归 Docs                                                                                                    | `file-category.ts`（新）、chips       | —            |
| FB-S4 | 搜索结果点击预览、长按菜单                                                                                                                            | 面板                                  | FB-S2、FB-U1 |
| FB-S5 | 空态/loading/超时/离线/重试                                                                                                                           | 面板                                  | FB-S2        |
| FB-S6 | 搜索 reader 保留 `totalCount/truncated`；32 条文案                                                                                                    | `use-mobile-file-search.ts`           | FB-S1        |
| FB-S7 | 懒加载树过滤：未加载目录保留标 “not loaded”；只隐藏已加载空目录；保留祖先                                                                             | 面板                                  | FB-S3        |
| FB-S8 | 旧主机 `files.list` 回退：5000 上限；在 `legacyFileListSchema`/`mobile-file-explorer-operations` 保留 total/truncated；`method_not_found`/`forbidden` | 搜索/reader/schema                    | FB-S1        |
| FB-S9 | 搜索 loading/离线状态与重复请求抑制                                                                                                                   | 面板/hook                             | FB-S2        |

## 4. 测试与发布

| ID    | 任务                                                                                      | 依赖                 |
| ----- | ----------------------------------------------------------------------------------------- | -------------------- |
| FB-Q1 | 单测：动作数组、分类、文件名/MIME、prepare 状态机、capability 探测                        | FB-T2/T3/T4A/T9      |
| FB-Q2 | 组件：长按菜单、搜索、过滤、预览菜单、Markdown 选择、读失败徽标                           | FB-U1..U12、S2/S3/S5 |
| FB-Q3 | 集成：RPC mock 分块/取消/超时/truncated/旧方法/5000 清单                                  | FB-T3/S1/S8          |
| FB-Q4 | Android/iOS 真机：SAF、ACTION_VIEW、Save to Files、15.9/16/16.1MB、18.2MB、哈希、24h、LRU | FB-T5..T9            |
| FB-Q5 | 回归：预览、媒体、可编辑终端文本 Save、web-shell、二进制行、单飞、保存结果页              | 全部                 |
| FB-Q6 | 旧二进制/OTA：缺 Sharing/Intent/SAF/contentUri 不崩溃、动作降级、native 路由              | FB-T4A/T11/U7        |
| FB-Q7 | 无障碍/触控/长按互斥/读屏                                                                 | FB-U1/U10            |
| FB-Q8 | 测试报告与证据归档                                                                        | 全部                 |

## 5. 合并顺序

1. 基础设施：FB-T1、T2、T3、T4A、T9、T10。
2. 菜单/预览：FB-U1、U2、U3、U4、U8、U9、U10、U12、U13。
3. 保存/打开：FB-T5、T6、T7、T8、T4、T4B。
4. 选择/OTA/搜索：FB-U5、U6、U7、FB-S1..S9。
5. HTML Frame 完成后：FB-U11。
6. FB-Q1..Q8 与发布验证。

## 6. Review-05 MINOR 处理决定

| 条目             | 决定                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| A10 Preview 数组 | 明确 list context 含 Preview；preview context 省略 Preview，其余顺序不变 |
| 截断提示歧义     | “截断提示”限定 worktree；终端 >512 KB 为 too large/仅 Copy path          |
| header Save      | 仅 dirty 可编辑文本渲染；clean/图片/只读不渲染；FB-U3/R4 已同步          |

## 7. 完成定义

- 本文任务全部完成；Q1..Q8 通过并归档证据（iOS/Android 必过）。
- 设计/代码/测试独立评审通过。
- 旧二进制 OTA 不崩溃且动作降级；新二进制商店构建可用。
- 不回归现有文件预览、媒体播放、终端产物编辑、目录懒加载。
- HTML 只追加模式动作，无第二套菜单或动作构造器。

## 8. 最终验收（2026-11-10）

- 设计评审、代码评审、测试评审、修复后复审均通过；测试评审确认 2 个原 FAIL 为误报。
- `regression-01.md`：自动化全量 10,687/10,696 通过（3 个 clean-HEAD 既有失败），Android 文件浏览 18 项完整 PASS；筛选芯片 40 dp 单行、SAF 保存 SHA 一致、搜索/过滤、长按菜单、读取失败重试均复验通过。
- 未覆盖项（不计 PASS）：iOS（Xcode 26 阻塞）、物理设备、save 大小矩阵/SAF cancel/rename/revoke、旧 host/旧二进制、SSH/folder workspace。
- 结论：Android/模拟器范围 FINAL_ACCEPT。
