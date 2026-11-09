#!/usr/bin/env python3
"""Record the Claude session behind an Orca pane so it can be resumed after a reboot."""
import json
import os
import re
import sys
import tempfile
import time

PANE = os.environ.get("ORCA_PANE_KEY")
if not PANE:
    sys.exit(0)

UUID_RE = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"


def safe_name(pane: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", pane)


def registry_dir() -> str:
    d = os.path.expanduser("~/.config/orca-claude-resume/sessions")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def atomic_write(path: str, obj: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

event = payload.get("hook_event_name") or ""
path = os.path.join(registry_dir(), safe_name(PANE) + ".json")
now = int(time.time())

if event == "SessionEnd":
    rec = {}
    try:
        with open(path) as f:
            rec = json.load(f)
    except Exception:
        rec = {"paneKey": PANE}
    reason = payload.get("reason") or "other"
    # Why: daemon/boot shutdown also ends the process (reason=other); only an explicit
    # user exit means the session should stay gone.
    intentional = reason in ("prompt_input_exit", "clear", "logout")
    rec.update(ended=intentional, endReason=reason, updatedAt=now)
    atomic_write(path, rec)
    sys.exit(0)

if event != "SessionStart":
    sys.exit(0)

sid = payload.get("session_id") or ""
if not re.fullmatch(UUID_RE, sid):
    sys.exit(0)

try:
    boot_id = open("/proc/sys/kernel/random/boot_id").read().strip()
except Exception:
    boot_id = ""

rec = {
    "version": 1,
    "paneKey": PANE,
    "terminalHandle": os.environ.get("ORCA_TERMINAL_HANDLE", ""),
    "sessionId": sid,
    "transcriptPath": payload.get("transcript_path", ""),
    "cwd": payload.get("cwd") or os.getcwd(),
    "source": payload.get("source", ""),
    "bootId": boot_id,
    "startedAt": now,
    "updatedAt": now,
    "ended": False,
    "endReason": None,
}
atomic_write(path, rec)

# The per-boot resume marker only needs to survive until the session actually
# starts. Clearing it here lets a later restore in the same boot resume again,
# while a failed resume (no SessionStart) keeps the marker and cannot loop.
if boot_id:
    try:
        run_dir = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "orca-claude-resume")
        os.unlink(os.path.join(run_dir, f"{boot_id}-{safe_name(PANE)}"))
    except OSError:
        pass
