# Orca 重启后自动复活 Claude（外挂方案）

> 日期：2026-11-09
> 适用：Orca 1.4.x（服务端 / 桌面端）、Claude Code 2.x
> 原则：**不修改 Orca 源码、不重启 Orca 服务、不动 Orca 配置**；全部通过外部契约实现
> 验证环境：`relay1`（100.98.189.51，Ubuntu 24.04，空闲主机）

---

## 1. 问题

Orca 有两种"重启"：

| 场景                                        | PTY / Claude 子进程       | 需要复活吗 |
| ------------------------------------------- | ------------------------- | ---------- |
| 只重启 `orca-server`（`systemctl restart`） | 终端守护进程和 PTY 都存活 | **不需要** |
| 整机 / pod 重启（崩溃、看门狗、断电）       | 全部消失                  | **需要**   |

整机重启后，Orca 的终端守护进程会恢复 **shell**（新的 bash + 历史快照），但不会恢复它当时的前台子进程。于是 Claude 对话从界面上"消失"了，虽然 transcript 仍在磁盘上。

Claude Code 本身支持完整恢复：

```bash
claude --resume <session-id>     # 精确恢复某个会话
claude -c                        # 恢复当前目录最近一个（多会话会串）
```

难的是两件事：

1. **恢复哪个 session**（同一 cwd 可能有多个 Claude 会话）
2. **怎么在 Orca 恢复的 shell 里自动触发**

---

## 2. 结论

**可以外挂实现，不需要改 Orca。**

外挂依赖以下已经存在且可观察的契约（均在 Orca 1.4.238 + lanmao 主机上确认）：

| 契约                                                                                                                   | 证据                                                                                               | 用途                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Orca 的 `bash --rcfile .../rcfile` 会 source `~/.bash_profile` / `~/.bash_login` / `~/.profile`                        | `~/.config/orca/shell-wrappers/d708bd5180e1f186/shell-ready/bash/rcfile:12-18`                     | 在恢复的 shell 里执行我们的代码                      |
| 每个 pane 注入 `ORCA_PANE_KEY`（`tabId:leafId`）和 `ORCA_TERMINAL_HANDLE`                                              | `tr '\0' '\n' < /proc/<shell>/environ`                                                             | 把会话和 pane 精确绑定                               |
| rcfile 定义 `claude` shell 函数（处理 profile pointer）                                                                | 同 rcfile 第 153 行                                                                                | 恢复时直接调用 `claude --resume`，行为与手动启动一致 |
| Claude Code 支持 `SessionStart` / `SessionEnd` hook，输入含 `session_id`、`transcript_path`、`cwd`、`source`、`reason` | lanmao `~/.config/orca/agent-hooks/last-status.json` 已记录 `providerSession.id` 与 transcriptPath | 记录"这个 pane 当时的会话 ID"                        |
| `claude --resume <id>`                                                                                                 | `claude --help`                                                                                    | 恢复对话                                             |

Claude 的正常退出会触发 `SessionEnd`；**主机崩溃/看门狗复位不会触发**。因此"记录仍在且 `ended=false`"本身就是"需要复活"的可靠标记。

---

## 3. 设计

```text
┌─────────────────────────────────────────────────────────────┐
│ Claude 启动                                                  │
│   SessionStart hook ──► ~/.config/orca-claude-resume/        │
│                          sessions/<paneKey>.json             │
│                          {sessionId, transcriptPath, ended:false}
│                                                              │
│ Claude 正常退出                                              │
│   SessionEnd hook   ──► 同一文件 ended:true                  │
│                                                              │
│ 主机崩溃 / 看门狗复位                                         │
│   不触发 SessionEnd ──► 记录保持 ended:false（= 待复活）      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Orca 重启后恢复 shell                                        │
│   bash --rcfile ... ── source ~/.profile                     │
│       └─ 设置 PROMPT_COMMAND=__orca_claude_resume            │
│                                                              │
│ 首个提示符前（此时 rcfile 已跑完、claude 函数已定义）         │
│   1. 读 <ORCA_PANE_KEY>.json                                 │
│   2. 校验：ended=false、transcript 存在、TTL 内、本 boot 未跑 │
│   3. printf 鼠标复位序列（顺手清掉死 TUI 留下的鼠标模式）     │
│   4. claude --resume <sessionId>                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 记录器：Claude SessionStart / SessionEnd hook

`~/.claude/hooks/orca-claude-session.py`：

- 非 Orca 环境（`ORCA_PANE_KEY` 为空）直接退出
- 原子写（临时文件 + rename），不阻塞 Claude 启动
- 只接受 UUID 形态的 `session_id`
- `SessionStart` 覆盖记录；`SessionEnd` 记录 `reason`：
  - 主动退出（`prompt_input_exit` / `clear` / `logout`）→ `ended=true`
  - 服务停止 / 正常 reboot 触发的终止（`reason=other`）→ 保留 `ended=false`，等待下次恢复
  - 这是受控 stop 测试发现的关键点：若把所有 SessionEnd 都当主动退出，优雅重启后不会自动恢复
- 路径：`~/.config/orca-claude-resume/sessions/<sanitized paneKey>.json`

记录格式：

```json
{
  "version": 1,
  "paneKey": "fd2cb4d5-...:13b156ee-...",
  "terminalHandle": "term_...",
  "sessionId": "d9605fb3-4de5-45a8-ab4a-8edba19a7cd9",
  "transcriptPath": "/home/nvidia/.claude/projects/.../d9605fb3-....jsonl",
  "cwd": "/home/nvidia/projects/minimax-h3-gateway",
  "source": "resume",
  "startedAt": 1794203000,
  "updatedAt": 1794203000,
  "ended": false,
  "endReason": null
}
```

Hook 配置（合并进现有 `hooks`，不要覆盖 Orca 的条目）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$HOME/.claude/hooks/orca-claude-session.py\" || true",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$HOME/.claude/hooks/orca-claude-session.py\" || true",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 3.2 恢复器：`~/.profile` + `PROMPT_COMMAND`

在 `~/.profile` 末尾追加（该文件被 Orca rcfile 显式 source；SSH 登录 shell 也会 source，但 `ORCA_PANE_KEY` 守卫使其不生效）：

```bash
# ── Orca: 恢复重启前正在运行的 Claude 会话 ──
__orca_claude_resume() {
  [ -z "${_ORCA_CLAUDE_RESUME_CHECKED:-}" ] || return 0
  _ORCA_CLAUDE_RESUME_CHECKED=1
  [ -n "${ORCA_PANE_KEY:-}" ] || return 0

  local out sid prompt
  out=$(python3 "$HOME/.claude/hooks/orca-claude-resume-lookup.py" 2>/dev/null) || return 0
  sid=${out%%$'\n'*}
  prompt=""
  [[ "$out" == *$'\n'* ]] && prompt=${out#*$'\n'}
  [ -n "$sid" ] || return 0

  # 死 TUI 可能留下鼠标上报模式；先复位数，避免 shell 回显 35;x;yM
  printf '\033[?9l\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1016l\033[?1005l\033[?1015l'
  local -a args=(--resume "$sid")
  [ -n "$prompt" ] && args+=("$prompt")
  claude "${args[@]}"
}

if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
  case "${PROMPT_COMMAND[*]:-}" in
    *__orca_claude_resume*) ;;
    *) PROMPT_COMMAND=(__orca_claude_resume "${PROMPT_COMMAND[@]}") ;;
  esac
else
  case ";${PROMPT_COMMAND:-};" in
    *";__orca_claude_resume;"*) ;;
    *) PROMPT_COMMAND="__orca_claude_resume${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
```

`orca-claude-resume-lookup.py` 的校验条件：

| 条件                                                                  | 原因                                    |
| --------------------------------------------------------------------- | --------------------------------------- |
| 记录存在且 `paneKey` 匹配                                             | 只恢复同一个 pane                       |
| `ended == false`                                                      | 正常退出过的不恢复                      |
| `sessionId` 是 UUID                                                   | 防注入 / 脏数据                         |
| `transcriptPath` 存在                                                 | `--resume` 的硬前提                     |
| `updatedAt` 在 TTL 内（默认 24h，可用 `ORCA_CLAUDE_RESUME_TTL` 覆盖） | 避免恢复很久以前的会话                  |
| `/run/user/$UID/orca-claude-resume/<boot_id>-<pane>` 不存在           | 防止恢复失败时 shell 反复重启导致死循环 |
| 输出 session id                                                       | 空输出 = 不恢复                         |

### 3.3 恢复后的定时任务（重要）

Claude Code 的定时任务分两类：

| 类型                     | 创建方式                                      | 存活范围                                        |
| ------------------------ | --------------------------------------------- | ----------------------------------------------- |
| **session-only**（默认） | `CronCreate` 不传 `durable` / `durable:false` | 只在当前 Claude 进程内存中；进程退出即消失      |
| **durable**              | `CronCreate` 传 `durable:true`                | 写入项目 `.claude/scheduled_tasks.json`，跨重启 |

`claude --resume <id>` 只恢复**对话 transcript**，不恢复进程内存，因此：

- **session-only：按工具说明不会继续**（"Session-only (not written to disk, dies when Claude exits)"）。但 2026-11-09 在 Claude Code 2.1.319 实测：`claude --resume <sid>` 后 `CronList` 仍列出原任务（项目 `.claude/scheduled_tasks.json` 为空），说明 resume 会从会话状态重建它们。版本间行为可能不同，因此仍保留按需提示让 Agent 核对，而不是假定任务已丢失。
- **durable：会继续。** 启动时从项目 `.claude/scheduled_tasks.json` 重新加载；要求恢复时 cwd 是同一个项目目录。
  - 停机期间错过的 recurring 触发**不补跑**，从下一个 cron 时间点开始；
  - 错过的 one-shot 会以通知形式提示，任务保留在文件中；
  - 调度器有项目级锁（`scheduled_tasks.lock`），同一项目只有一个会话在跑定时任务；旧进程的 stale lock 会被回收；
  - 加载时通过 `createdBySessionId` + 项目内 transcript 校验来源，避免复制自其他 checkout 的任务误跑。

**建议**：需要跨重启继续的周期任务，创建时显式要求 `durable: true`。检查现有任务：

```bash
cat <project>/.claude/scheduled_tasks.json
```

#### 3.3.1 按需注入提示词（避免污染会话）

lookup 在恢复前单遍扫描 transcript，只在那确实有事可做时注入 prompt：

| 检查                           | 依据                                                                                                                 | 注入                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 未停止的 session-only 定时任务 | 依次处理 `CronCreate` 结果、`CronDelete` 输入、最近一次 `CronList` 快照                                              | `恢复没有停止的定时任务：已被删除或停止的不要恢复，不要重复创建；如果没有定时任务，不要说明无任务原因。` |
| 未完成回合                     | 仍有未回填的 `tool_use`，或最后一条是用户消息/工具结果，或 `stop_reason` 为 `tool_use` / `max_tokens` / `pause_turn` | `请继续处理中断前未完成的任务；如果没有未完成的任务，保持沉默。`                                         |
| 整机重启                       | 记录里的 `bootId` 与当前不同                                                                                         | OOM/看门狗复盘提示                                                                                       |
| 以上都没有                     | —                                                                                                                    | 只输出 sessionId，静默恢复，不产生用户回合                                                               |

- 不再用"历史上出现过 CronCreate"作为判据，避免任务早已删除却仍注入提示
- durable 任务会自行从项目文件重载，不注入
- 多个 prompt 按空格拼接成一个位置参数
- `ORCA_CLAUDE_RESUME_DEBUG=1` 输出 `jobs=… unfinished=…` 便于排查

profile 在恢复时把 prompt 作为位置参数传给 Claude（交互模式，等效于手动输入）：

```bash
# 还有未停止的定时任务
claude --resume <sid> "恢复没有停止的定时任务：…；如果没有定时任务，不要说明无任务原因。"
# 还有未完成的回合
claude --resume <sid> "请继续处理中断前未完成的任务；如果没有未完成的任务，保持沉默。"
# 无事可做：静默恢复
claude --resume <sid>
```

扫描是流式的，77 MB transcript 约 0.5 s。

**主机重启后的复盘提示**：记录里保存了 `bootId`。恢复时如果当前 boot id 与记录不同（说明发生过整机重启），会在恢复 prompt 前追加：

```text
本会话已由 Orca 自动恢复。请检查系统日志，确认本次中断是否由内存耗尽/OOM、
GPU OOM 或看门狗复位导致（如 journalctl -b -1、earlyoom、NVRM、内核日志）；
若确认，分析原因并采取优化措施，避免再次发生。
```

- 同一 boot 内的服务停止/启动不追加，避免噪音
- 重启后 Agent 会先做原因排查，再处理原会话任务

### 3.4 状态机

| 事件                     | 记录                                     | 下次 shell 恢复时           |
| ------------------------ | ---------------------------------------- | --------------------------- |
| 正常 `/exit`、Ctrl-D     | `ended=true`（reason=prompt_input_exit） | **不恢复**                  |
| 主机崩溃 / 看门狗 / 断电 | `ended=false`（无 SessionEnd）           | **恢复**                    |
| 服务 stop / 正常 reboot  | `ended=false`（SessionEnd reason=other） | **恢复**                    |
| Claude 被用户 `kill -9`  | `ended=false`                            | **恢复**                    |
| `/clear`                 | SessionEnd(clear) + SessionStart(新 id)  | 恢复新会话                  |
| `--resume` 启动          | SessionStart(source=resume) 覆盖记录     | 恢复同一会话                |
| 只重启 orca-server       | shell 未重建，PROMPT_COMMAND 不执行      | 无动作（Claude 本来就没死） |

---

## 4. 部署清单

已固化的可部署文件在 [`scripts/claude-auto-resume/`](../scripts/claude-auto-resume/)：

| 仓库文件                       | 部署位置                                       | 作用                                    |
| ------------------------------ | ---------------------------------------------- | --------------------------------------- |
| `orca-claude-session.py`       | `~/.claude/hooks/orca-claude-session.py`       | 记录器                                  |
| `orca-claude-resume-lookup.py` | `~/.claude/hooks/orca-claude-resume-lookup.py` | 恢复条件判定                            |
| `profile-snippet.sh`           | 追加到 `~/.profile`                            | `PROMPT_COMMAND` 恢复器                 |
| —                              | `~/.claude/settings.json`                      | 追加 `SessionStart` / `SessionEnd` hook |
| —                              | `~/.config/orca-claude-resume/sessions/`       | 注册表（自动创建，0700）                |

**多 Claude profile 注意**：如果 Orca 通过 `ORCA_CLAUDE_PROFILE_POINTER` 切换 `CLAUDE_CONFIG_DIR`，hook 必须装到实际生效的那个配置目录的 `settings.json` 里；注册表仍共用 `~/.config/orca-claude-resume/`。

---

## 5. 备选方案：systemd --user + `orca terminal send`

如果未来 Orca 改变 rcfile 行为，可以换成一个完全独立的恢复服务：

```text
systemd --user (default.target)
  └─ sleep 30 等待 Orca ready
     ├─ orca terminal list --json        # handle / tabId / leafId / ptyId
     ├─ 读注册表（同一份 SessionStart hook 写入）
     └─ orca terminal send --terminal <handle> --text "claude --resume <id>" --enter
```

优点：不依赖 `~/.profile`；缺点：多一个服务、需要 paneKey→handle 匹配和幂等控制。两者可以同时装，恢复器用注册表里的 boot 标记互斥。

---

## 6. 验证方案（relay1）

relay1 没有 Orca 和 Claude，因此用**等价契约模拟 + 真实 Claude Code**：

1. 安装 Node/Claude Code（npm，npmmirror）
2. 创建隔离 HOME：`/root/claude-resume-lab/{home,claude}`
3. 安装两个 hook 脚本与 settings
4. 构造与 Orca 等价的 rcfile：
   ```bash
   [[ -f /etc/profile ]] && source /etc/profile
   if [[ -f "$HOME/.bash_profile" ]]; then source "$HOME/.bash_profile"
   elif [[ -f "$HOME/.bash_login" ]]; then source "$HOME/.bash_login"
   elif [[ -f "$HOME/.profile" ]]; then source "$HOME/.profile"; fi
   function claude { command claude "$@"; }
   ```
5. 用 tmux 在 PTY 中启动 `bash --rcfile <rcfile> -i`，注入 `ORCA_PANE_KEY` / `ORCA_TERMINAL_HANDLE`

### 测试用例

| #   | 场景                         | 期望                                      |
| --- | ---------------------------- | ----------------------------------------- |
| T1  | 首次启动 Claude              | 注册表出现 `ended=false` 与正确 sessionId |
| T2  | 正常退出 Claude，重建 shell  | **不**自动恢复                            |
| T3  | `kill -9` Claude，重建 shell | 自动执行 `claude --resume <同一 id>`      |
| T4  | 同一 boot 再次重建 shell     | 不重复恢复（marker 生效）                 |
| T5  | 无 `ORCA_PANE_KEY` 的 shell  | 不执行任何恢复                            |

### 通过标准

- T1/T3 的 sessionId 与 transcript 路径完全一致
- T2 不产生 `claude` 进程
- T4 的 marker 存在且不重复
- T5 无副作用

---

## 7. 风险与回滚

| 风险                                      | 处理                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 误恢复用户已关闭的会话                    | SessionEnd 标记 `ended=true`；TTL + 只认同一 pane                                                  |
| 恢复时 Claude 已在运行                    | PROMPT_COMMAND 每 shell 只执行一次；恢复路径只在 shell 新建时发生                                  |
| Orca 修改 rcfile 不再 source `~/.profile` | 回退到第 5 节 systemd 方案                                                                         |
| 多 profile 导致 hook 未生效               | hook 装到每个 `CLAUDE_CONFIG_DIR`                                                                  |
| 脚本异常影响 shell 启动                   | 所有失败路径 `                                                                                     |     | return 0`，lookup 无输出即跳过 |
| 恢复命令带错参数                          | 通过 rcfile 的 `claude` 函数调用，与手动启动完全同路径；如需额外参数可加 `ORCA_CLAUDE_RESUME_ARGS` |

回滚：删除两个 hook 条目、`~/.profile` 中的代码块、两个脚本和注册表目录即可；不影响 Orca。

---

## 8. 验证结果（2026-11-09，relay1）

**结论：T1–T5 全部通过。**

### 环境

| 项          | 值                                                   |
| ----------- | ---------------------------------------------------- |
| 主机        | `relay1`（100.98.189.51，`iZwz9htk3kjsdb0gubtiahZ`） |
| 系统        | Ubuntu 24.04.5 LTS，x86_64，1.7 GB RAM               |
| Claude Code | 2.1.319                                              |
| Orca        | 未安装；用等价 rcfile + `ORCA_PANE_KEY` 模拟         |
| API         | 本地 mock（127.0.0.1:8089），仅用于让 TUI 启动       |
| 工具        | tmux 3.x、strace                                     |

### 用例与结果

| #   | 场景                                  | 结果     | 证据                                                                                                   |
| --- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| T1  | 首次启动 Claude                       | **通过** | 注册表写入 `sessionId=f381d757-27e3-4c66-96a5-173e019a97e4`、`ended=false`、`source=startup`           |
| T2  | 正常 `/exit` 后重建 shell             | **通过** | 注册表 `ended=true, endReason=prompt_input_exit`；重建后无 `claude` 进程                               |
| T3  | `kill -9` Claude 后重建 shell         | **通过** | 自动启动 `claude --resume f381d757-27e3-4c66-96a5-173e019a97e4`；注册表更新为 `source=resume`          |
| T4  | 同一 boot 再次重建 shell              | **通过** | marker `/run/user/0/orca-claude-resume/f36b03f1-...-testtab-1_testleaf-1` 存在；无重复恢复             |
| T5  | 无 `ORCA_PANE_KEY` 的 shell           | **通过** | 无任何 `claude` 进程、无副作用                                                                         |
| T6  | transcript 含 `CronCreate` 的会话恢复 | **通过** | 进程为 `claude --resume <sid> "恢复定时任务：先用 CronList 检查现有任务…"`；transcript 中出现该 prompt |
| T7  | transcript 无定时任务的会话恢复       | **通过** | 仅 `claude --resume <sid>`，未追加 prompt                                                              |

### 验证中发现并确认的行为

1. **`SessionStart` 先于第一条消息触发**，但此时 transcript 文件可能尚未创建（空会话）。lookup 要求 transcript 存在，因此空会话不会被恢复——这是有意设计，避免 `--resume` 失败。
2. **`SessionEnd` 的 `reason` 为 `prompt_input_exit`**（`/exit`），可以可靠区分正常退出。
3. `kill -9` 不触发 `SessionEnd`，注册表保持 `ended=false`，与主机崩溃语义一致。
4. 模拟 Orca 的 rcfile（source `~/.profile` 后再定义 `claude` 函数）下，`PROMPT_COMMAND` 在首个提示符前执行时 `claude` 函数已可用，恢复命令走的是与手动启动相同的路径。
5. 测试主机首次运行会遇到信任弹窗；真实 lanmao 主机已信任过工作区，不受影响。

### 尚未在 relay1 覆盖的部分

- 真实 Orca 守护进程恢复 PTY 的完整链路（rcfile 与 `ORCA_PANE_KEY` 已从 lanmao 实测确认）
- 真实 Claude 配置 profile pointer 下的多配置目录（需在目标机按第 4 节注意事项安装 hook）

relay1 上的实验目录与后台 mock 进程已在验证后清理。

---

## 9. 验证结果（2026-11-09，lanmao 受控 stop/start）

真实 Orca 终端 + 真实服务停止/启动，不修改 Orca。

| 项                        | 结果                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| 停止                      | `systemctl stop orca-server` + 停止 `orca-daemon-*.scope` / PTY slice；服务 `inactive`               |
| 启动                      | `systemctl start orca-server`；新 daemon `f32f6c71…`，PTY slice 与 2 个 shell 恢复                   |
| pane `f148288b…`          | 自动 `claude --resume c563505a-… "恢复没有停止的定时任务：已被删除或停止的不要恢复，不要重复创建。"` |
| pane `fd2cb4d5…`          | 自动 `claude --resume d9605fb3-… <同一 prompt>`                                                      |
| prompt 生效               | 两条 transcript 中均出现该 prompt，作为正常用户回合                                                  |
| 注册表                    | 恢复后 `source=resume`、`ended=false`、写入当前 `bootId=cf33e034…`                                   |
| marker                    | SessionStart 成功后 marker 被删除，目录为空；后续同 boot 不再重复恢复                                |
| 已关闭的 pane `c9b76b6b…` | 无 shell、未恢复（记录保持不变）                                                                     |
| REBOOT_PROMPT             | 未追加：本次是同一 boot 的 stop/start，且旧记录尚无 `bootId`                                         |

**待验证**：真实整机重启（或 `reboot`）后，`bootId` 变化应触发 OOM/看门狗复盘提示。

### 9.1 按需注入优化（2026-11-09，受控 stop/start 实测通过）

恢复脚本改为先检查再注入（见 3.3.1）。22:46 stop → 等待 60 秒 → 22:54 start，新 daemon `2708497c…`。

| pane                    | 恢复前检查                                                               | 实际注入                 | 结果                                                                                          |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------- |
| `f148288b…`（c563505a） | 2 个未停止的 session-only 任务（`99c3eb05`、`d6276371`）；最后回合已完成 | 仅定时任务提示，22:54:38 | resume 后 `CronList` 确认两个任务都在，未重复创建；随后重启 e3、resume V16 子代理，继续原工作 |
| `fd2cb4d5…`（d9605fb3） | 无活动任务；最后回合已完成                                               | 无提示                   | 只 `claude --resume <sid>`；transcript 无新用户回合，静默恢复                                 |
| `c9b76b6b…`             | pane 已关闭                                                              | —                        | 未恢复                                                                                        |

- 注册表：两条恢复记录 `source=resume`、`ended=false`、`bootId=cf33e034…`
- marker：SessionStart 成功后清空
- 同一 boot 不注入 OOM 复盘提示

**结论**：按需注入生效，无任务的会话不再被提示词污染。`unfinished` 在两个会话均为 False（停止时都处于完成回合），"继续处理未完成任务"路径本次未触发。

**额外观察**：resume 后 `CronList` 仍能看到原 session-only 任务，而项目 `scheduled_tasks.json` 为空（见 3.3 修正）。Agent 因此只核对、未重复创建，符合提示词要求。
