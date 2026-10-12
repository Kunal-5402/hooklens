"""Hook entry point. Runs inside the agent's tool loop, so it must be fast and silent.

It reads the payload from stdin, trims large strings, inserts one raw row, and exits 0.
Claude Code and Codex read hook stdout as instructions, so the hook prints nothing for them.
Cursor reads stdout as JSON for every event and can block an action on empty output, so the
hook always answers Cursor with a reply that changes nothing.

The exception is a configured policy (see policy.py): for a "before" event, the hook asks the
policy engine first, stores its decision with the event, and prints the decision for the agent.
"""

import json
import os
import sys
import time
import traceback

from hooklens import db, paths

PATCH_MARK = "*** Begin Patch"
CURSOR_REPLIES = {"beforeSubmitPrompt": '{"continue": true}'}


def max_field() -> int:
    try:
        return int(os.environ.get("HOOKLENS_MAX_FIELD", "4096"))
    except ValueError:
        return 4096


def truncate(value, limit: int):
    """Trim long strings. Patch headers survive, so file paths in big patches are kept."""
    if isinstance(value, str):
        if limit <= 0 or len(value) <= limit:
            return value
        head = value[:limit]
        if PATCH_MARK in value:
            headers = [ln for ln in value.splitlines() if ln.startswith("*** ") and ln not in head]
            head += "\n" + "\n".join(headers)
        return f"{head}\n…[hooklens: truncated {len(value) - limit} chars]"
    if isinstance(value, dict):
        return {k: truncate(v, limit) for k, v in value.items()}
    if isinstance(value, list):
        return [truncate(v, limit) for v in value]
    return value


def session_key(payload: dict) -> str | None:
    """Cursor names the session conversation_id; Claude Code and Codex name it session_id."""
    return payload.get("conversation_id") or payload.get("session_id")


def _event_name(raw: bytes) -> str | None:
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    return payload.get("hook_event_name") if isinstance(payload, dict) else None


def record(agent: str, raw: bytes, decision: dict | None = None) -> None:
    limit = max_field()
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = {"_unparsed": raw.decode(errors="replace")[: limit or None]}
    if not isinstance(payload, dict):
        payload = {"_value": payload}
    payload.pop("user_email", None)  # Cursor sends it on every event; hooklens does not need it.
    if decision:
        from hooklens.policy import KEY

        payload[KEY] = decision
    payload = truncate(payload, limit)
    conn = db.connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO raw_events(agent, hook_event, session_id, received_at, payload) VALUES (?, ?, ?, ?, ?)",
                (agent, payload.get("hook_event_name"), session_key(payload), time.time(), json.dumps(payload)),
            )
    finally:
        conn.close()


def _log_error(agent: str) -> None:
    try:
        paths.error_log().parent.mkdir(parents=True, exist_ok=True)
        with open(paths.error_log(), "a") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} hook {agent}\n{traceback.format_exc()}\n")
    except OSError:
        pass


def run(agent: str) -> int:
    raw = b""
    checked = None
    try:
        raw = sys.stdin.buffer.read()
        if paths.policy_config().exists():  # a stat only, so the hook stays fast without a policy
            from hooklens import policy

            checked = policy.check(agent, raw)
    except Exception:
        _log_error(agent)
    try:
        if raw:
            record(agent, raw, checked[1] if checked else None)
    except Exception:
        _log_error(agent)
    finally:
        out = None
        if checked:
            from hooklens import policy

            out = policy.reply(agent, *checked)
        elif agent == "cursor":
            out = CURSOR_REPLIES.get(_event_name(raw), "{}")
        if out is not None:
            sys.stdout.write(out)
            sys.stdout.flush()
    return 0
