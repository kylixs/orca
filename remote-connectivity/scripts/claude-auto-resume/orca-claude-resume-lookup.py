#!/usr/bin/env python3
"""Print the Claude session id to resume for this Orca pane, or nothing."""
import json
import os
import re
import sys
import time

UUID_RE = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
JOB_RE = r"(?m)^([0-9a-f]{8}) — .*\[session-only\]"
CREATED_RE = r"Scheduled (?:recurring )?job ([0-9a-f]{8})"

# Only a session that was not explicitly ended reaches this point.
TASK_PROMPT = (
    "恢复没有停止的定时任务：已被删除或停止的不要恢复，不要重复创建；"
    "如果没有定时任务，不要说明无任务原因。"
)
CONTINUE_PROMPT = "请继续处理中断前未完成的任务；如果没有未完成的任务，保持沉默。"

# Only used when the boot id changed: a host reboot is what needs a post-mortem.
REBOOT_PROMPT = (
    "本会话已由 Orca 自动恢复。请检查系统日志，确认本次中断是否由内存耗尽/OOM、"
    "GPU OOM 或看门狗复位导致（如 journalctl -b -1、earlyoom、NVRM、内核日志）；"
    "若确认，分析原因并采取优化措施，避免再次发生。"
)


def result_text(block):
    content = block.get("content")
    if isinstance(content, list):
        return " ".join(x.get("text", "") for x in content if isinstance(x, dict))
    return content if isinstance(content, str) else ""


def scan_transcript(path):
    """Return (active session-only job ids, whether the last turn is unfinished)."""
    jobs = set()
    pending = set()
    tool_names = {}
    last_kind = None
    last_stop = None

    try:
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if entry.get("isSidechain"):
                    continue

                kind = entry.get("type")
                msg = entry.get("message") or {}
                content = msg.get("content")

                if kind == "assistant":
                    last_kind, last_stop = "assistant", msg.get("stop_reason")
                    if not isinstance(content, list):
                        continue
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            tid = block.get("id")
                            name = block.get("name") or ""
                            if tid:
                                pending.add(tid)
                                tool_names[tid] = name
                            if name == "CronDelete":
                                job = (block.get("input") or {}).get("id")
                                if job:
                                    jobs.discard(job)
                elif kind == "user":
                    if isinstance(content, str):
                        if content.strip():
                            last_kind, last_stop = "user_text", None
                            pending.clear()
                        continue
                    if not isinstance(content, list):
                        continue

                    saw_result = saw_text = False
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "tool_result":
                            saw_result = True
                            tid = block.get("tool_use_id")
                            pending.discard(tid)
                            text = result_text(block)
                            if tool_names.get(tid) == "CronCreate":
                                m = re.search(CREATED_RE, text)
                                if m and "Session-only" in text:
                                    jobs.add(m.group(1))
                            elif tool_names.get(tid) == "CronList":
                                if "No scheduled jobs." in text:
                                    jobs.clear()
                                else:
                                    jobs = set(re.findall(JOB_RE, text))
                        elif block.get("type") == "text" and (block.get("text") or "").strip():
                            saw_text = True
                    if saw_result:
                        last_kind, last_stop = "tool_result", None
                    elif saw_text:
                        last_kind, last_stop = "user_text", None
                        pending.clear()
    except OSError:
        return set(), False

    unfinished = bool(pending) or last_kind in ("user_text", "tool_result")
    # A truncated or paused assistant turn never finished its work.
    if last_kind == "assistant" and last_stop in ("tool_use", "max_tokens", "pause_turn"):
        unfinished = True
    return jobs, unfinished


pane = os.environ.get("ORCA_PANE_KEY", "")
if not pane:
    sys.exit(0)

safe = re.sub(r"[^A-Za-z0-9._-]", "_", pane)
path = os.path.expanduser(f"~/.config/orca-claude-resume/sessions/{safe}.json")
try:
    with open(path) as f:
        rec = json.load(f)
except Exception:
    sys.exit(0)

if rec.get("paneKey") != pane or rec.get("ended"):
    sys.exit(0)
sid = rec.get("sessionId") or ""
if not re.fullmatch(UUID_RE, sid):
    sys.exit(0)
transcript = rec.get("transcriptPath") or ""
if not transcript or not os.path.isfile(transcript):
    sys.exit(0)
ttl = int(os.environ.get("ORCA_CLAUDE_RESUME_TTL", "86400"))
if time.time() - int(rec.get("updatedAt") or 0) > ttl:
    sys.exit(0)

try:
    boot = open("/proc/sys/kernel/random/boot_id").read().strip()
except Exception:
    boot = "unknown"

run_dir = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "orca-claude-resume")
marker = os.path.join(run_dir, f"{boot}-{safe}")
if os.path.exists(marker):
    sys.exit(0)
os.makedirs(run_dir, mode=0o700, exist_ok=True)
with open(marker, "w") as f:
    f.write(str(int(time.time())))

jobs, unfinished = scan_transcript(transcript)
if os.environ.get("ORCA_CLAUDE_RESUME_DEBUG"):
    print(f"jobs={sorted(jobs)} unfinished={unfinished}", file=sys.stderr)
prompts = []
if boot != "unknown" and rec.get("bootId") and rec.get("bootId") != boot:
    prompts.append(REBOOT_PROMPT)
if jobs:
    prompts.append(TASK_PROMPT)
if unfinished:
    prompts.append(CONTINUE_PROMPT)

print(sid)
if prompts:
    print(" ".join(prompts))
