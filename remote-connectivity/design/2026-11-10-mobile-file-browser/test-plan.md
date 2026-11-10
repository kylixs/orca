# 移动端文件浏览：测试方案

> 对应设计：`design.md`（第 8 节优先）
> 目标：证明长按复制、保存到手机、用其它 App 打开、搜索过滤在 iOS/Android 真实设备端到端可用，且不回归现有预览。

## 1. 环境

| 环境 | 用途 |
|---|---|
| Node + Vitest | 单元/组件测试 |
| TypeScript / oxlint | 静态检查 |
| Android 模拟器/真机 | SAF、ACTION_VIEW、FileProvider、长按 |
| iOS 模拟器/真机（**必过**） | Save to Files、分享、UTI/iPad anchor |
| SSH / folder workspace | 分块读取、路径安全 |
| 旧二进制模拟 | OTA JS + 缺少共享/Intent 原生模块 |
| Mock RPC | `files.*` 超时/失败/truncated/旧方法 |

记录设备型号、OS、App 构建号、WebView、命令、截图/录屏路径。

## 2. AC → 用例

| AC | 用例 |
|---|---|
| AC1 长按选中复制 | A1..A15 |
| AC2 操作菜单 | A1..A3、A10、B1..B23、C1..C7 |
| AC3 保存/打开结果与错误 | B1..B23、C1..C7 |
| AC4 进度/取消 | B3/B4/B14/B15/B19/B20/B21、R10 |
| AC5 搜索/过滤 | D1..D14 |
| AC6 回归 | R1..R12 |

## 3. 用例

### A. 长按、复制、行状态

| ID | 场景 | 预期 |
|---|---|---|
| A1 | 长按文本文件行 | 动作数组：Preview、Save to phone、Open with、Copy content、Copy path、Cancel；无 Download |
| A2 | 长按目录行 | 只显示 Copy path、Cancel；点击行展开/折叠 |
| A3 | 长按二进制/PDF 行 | 数组：Save to phone、Open with、Copy path、Cancel；无 Preview/Copy content；行可聚焦 |
| A4 | 代码预览长按 | 系统选择菜单出现，复制与选中一致 |
| A5 | Markdown 渲染段落在 Android 长按 | 段落/标题/列表/代码可选；复制正确（document 模式，不受 `androidTranscript` 影响） |
| A6 | Markdown 源码模式 | 可选复制 |
| A7 | Copy content | 按需读取；≤512 KB；截断时复制前 512 KB 并提示 |
| A8 | Copy path | 复制 worktree 相对路径 |
| A9 | CJK/emoji/折行选择 | 与视觉一致，无乱码 |
| A10 | 类型矩阵（list context 完整数组） | 文本/代码/Markdown/HTML：Preview、Save to phone、Open with、Copy content、Copy path、Cancel；图片/媒体：Preview、Save、Open、Copy path、Cancel；PDF/二进制：Save、Open、Copy path、Cancel；目录：Copy path、Cancel；终端文本：同文本；终端图片：同图片；终端超预算：Copy path、Cancel。**preview context 省略 Preview 项**（当前文件已在预览），其余顺序不变 |
| A11 | HTML 渲染视图选择 | 依赖 HT-U6/HT-V1；长按选文字不触发链接；点击链接仍外开（跨需求） |
| A12 | 长按后释放 | 不触发预览；菜单只出现一次 |
| A13 | 读取失败/无权限（含跨屏） | 预览失败 → 返回列表 → 行显示 Read failed 徽标 → Retry 成功后清除；重连只清断线/超时，EACCES/ENOENT 需 Retry |
| A14 | 0 字节/空文件 | 不崩溃；预览显示空态；保存产生 0 字节文件 |
| A15 | Copy path（终端产物） | 复制 `pathText ?? displayPath`；grant 刷新后仍复制用户可见路径 |

### B. 保存到手机

| ID | 场景 | 预期 |
|---|---|---|
| B1 | Save 10 KB 文本（Android） | SAF 选目录 → 写入；系统文件管理器可见；SHA-256 一致 |
| B2 | Save 5 MB 二进制（Android） | 分块读取 + SAF；大小/MIME 正确；哈希一致 |
| B3 | Save 18.2 MB（Android） | 超过 SAF 直写阈值 → 分享面板保存；不构造大 JS 字符串；哈希一致 |
| B4 | Save 100 MB | 分享路径；进度平滑；可取消；取消后临时文件清理 |
| B5 | >256 MB | 明确提示 “File is too large; save it on desktop.”；不写半成品 |
| B6 | 弱网/断线 | 失败提示；重试从头开始，不做续传 |
| B7 | iOS Save to Files | 系统面板保存；文件可打开；UTI 正确 |
| B8 | SAF 取消/权限撤销/重名 | 取消无文件；权限撤销提示；重名追加 ` (1)` 且保留扩展名 |
| B9 | 终端文本 ≤512 KB Save | 可保存；toast “Saved to phone”；与桌面写回 Save 区分 |
| B10 | 终端文本 >512 KB | “Too large for mobile; open on desktop”；仅 Copy path；无 Save/Open/Copy content |
| B11 | 终端图片 ≤~3 MB | 可保存/打开；哈希一致 |
| B12 | 终端图片 >~3 MB | 提示 “Too large for mobile; open on desktop”；只保留 Copy path |
| B13 | grant 过期 | 自动刷新后成功；刷新失败提示 |
| B14 | 预览页发起 Save | 进度/取消/重试在预览页内完成，不跳回列表 |
| B15 | 分享/保存后 5 分钟与 24h | 5 分钟内目标 App 仍可读；24h/清理后不存在 |
| B16 | 应用被杀/重启 | 孤儿缓存清理；未完成下载无半成品 |
| B17 | SSH worktree Save | 与本地一致；路径不穿越 |
| B18 | 仅 prepare 不 Save | 不产生用户可见文件（不再有独立 Download） |
| B19 | 16MB 边界 | 15.9MB SAF；16MB SAF；16.1MB 分享回退；均哈希一致 |
| B20 | LRU 512MB | 填满后最旧项淘汰、最新项保留；启动孤儿清理 |
| B21 | 保存结果页 | 显示路径 + SHA-256 + “Cached copy kept for 24 hours”；关闭后回到预览/列表 |
| B22 | MIME/UTI 映射 | png/jpg/gif/webp/pdf/zip/mp4/mp3/md/txt/ts/tsx/html 与设计表一致；代码/纯文本 `text/plain`；未知 `application/octet-stream` + 无应用提示 |
| B23 | terminal header Save 可见性 | 仅“可编辑文本 + 有未保存修改”显示且启用；图片/只读/超预算/无修改不渲染 |

### C. 用其它 App 打开

| ID | 场景 | 预期 |
|---|---|---|
| C1 | Android ACTION_VIEW | content URI + `FLAG_GRANT_READ_URI_PERMISSION`；chooser 出现；目标 App 可读 |
| C2 | iOS 分享 | 目标 App 可读；iPad anchor 不崩溃 |
| C3 | 无可用 App/分享不可用 | 提示；提供 Save to phone |
| C4 | prepare 未完成点 Open | 禁用或等待；不打开半成品 |
| C5 | 分享取消 | 回预览；cache 保留 24h，不立即删 |
| C6 | 旧二进制缺少 ExpoSharing/Intent/SAF/contentUri | 不静态崩溃；按缺失项隐藏 Save/Open；显示 “Update Orca on this device to use file actions” |
| C7 | 旧二进制 OTA 文件页 | 强制 native；动作集合按能力降级；Copy path/content 可用 |

### D. 搜索与过滤

| ID | 场景 | 预期 |
|---|---|---|
| D1 | 搜索未展开目录文件名 | 返回结果；点击预览 |
| D2 | 中文/emoji/特殊字符文件名 | 结果正确；无崩溃 |
| D3 | 旧主机 `method_not_found` / `forbidden` | 用 `isMobileMethodUnavailableError` 判定；`files.list` 回退；提示范围 |
| D4 | 无结果/loading/超时/离线 | 各自状态可见；可重试/清空 |
| D5 | 过滤 chips | All/Code/Docs/Media/Images/Other；PDF 归 Docs；树与结果同步 |
| D6 | 搜索 + 过滤 | 结果同时满足；显示 “Showing first 32 of N” |
| D7 | 长按搜索结果 | 同一文件操作 sheet；目标正确 |
| D8 | limit 边界 | 最多 32 条；totalCount/truncated 正确显示 |
| D9 | 文件库 >20k | 显示“结果可能不完整”；不宣称无匹配 |
| D10 | 过滤懒加载树 | 未加载目录保留并标 “not loaded”；已加载空目录隐藏；有匹配的祖先保留；层级不断裂 |
| D11 | 旧主机清单 >5000 | 显示 “Showing first 5000; results may be incomplete”；不称全量 |
| D12 | 点击搜索结果 | 进入预览，不触发 sheet |
| D13 | 搜索中滚动/清空 | 无重复请求；恢复树 |
| D14 | 过滤受 32 条上限限制 | 显示 “Showing first 32 of N matches”（N 为 totalCount），不暗示过滤了全部 |

### E. 回归

| ID | 场景 | 预期 |
|---|---|---|
| R1 | 目录懒加载/展开/缓存 | 不变 |
| R2 | 文本/图片/媒体/HTML 预览 | 不变 |
| R3 | 媒体播放/缓存清理 | 不变 |
| R4 | 终端产物编辑/Save | 仅 dirty 可编辑文本显示并启用 Save；干净/图片/只读不渲染；溢出菜单并存 |
| R5 | 旧桌面 `files.list` 回退 | 不变 |
| R6 | OTA/旧二进制 | native 路由；能力降级；不崩溃 |
| R7 | 二进制行 | 可聚焦/长按；仅 Preview 隐藏 |
| R8 | 无障碍 | 44×44/hitSlop；读屏可触发菜单；长按触觉 |
| R9 | `openExternalLink` 等无关契约 | 不变 |
| R10 | 单飞进度 | 同一文件重复 Save/Open 只执行一次；列表/预览共享进度 |
| R11 | 长按/点击互斥 | 长按释放不预览 |
| R12 | iOS 必过 | 无“未覆盖”例外 |

## 4. 测试数据

- 大小：0、10 KB、5 MB、15.9/16/16.1 MB、18.2 MB、100 MB、256 MB、>256 MB；worktree 文本 511/512/513 KB；终端文本 512 KB/513 KB（后者 too large）；图片 ~3 MB/5 MB。
- 类型：txt/md/html/png/jpg/pdf/zip/mp4/ts/tsx/无扩展名/点文件。
- 文件名：CJK、emoji、空格、特殊字符、超长、重名、Unicode 双向控制符。
- 路径：`..`、符号链接、控制字符、工作区外。
- 搜索：32/33、5000/5001、20k 文件库；懒加载未展开目录。
- 主机：本地、SSH、folder workspace。

## 5. 执行与证据

```bash
pnpm --dir mobile test
pnpm --dir mobile typecheck
pnpm --dir mobile lint
pnpm tc
adb devices
adb exec-out screencap -p > evidence/file-actions.png
xcrun simctl list devices
```

- 每条记录步骤、预期、实际、截图/录屏、文件哈希。
- iOS 与 Android 都是必过项；旧二进制/旧主机用例单独记录构建号。
- 报告归档到 `test-reports/`。
