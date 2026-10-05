"""Read models for the CLI and the UI: session lists, event lists, files, summary."""

import json
import sqlite3
from collections import Counter

from hooklens.adapters import programs

SESSION_COLS = (
    "id, agent, cwd, model, title, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens,"
    " cache_write_tokens, prompt_count, tool_call_count, error_count"
)


def list_sessions(conn: sqlite3.Connection, agent: str | None = None, limit: int = 500) -> list[dict]:
    sql = f"SELECT {SESSION_COLS} FROM sessions"
    args: list = []
    if agent:
        sql += " WHERE agent=?"
        args.append(agent)
    sql += " ORDER BY started_at DESC LIMIT ?"
    args.append(limit)
    return [dict(r) for r in conn.execute(sql, args)]


def find_session(conn: sqlite3.Connection, prefix: str) -> str | None:
    rows = conn.execute("SELECT id FROM sessions WHERE id LIKE ? LIMIT 2", (prefix + "%",)).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def event_detail(conn: sqlite3.Connection, event_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if not row:
        return None
    out = dict(row)
    out["detail"] = json.loads(out["detail"] or "{}")
    out["files"] = [dict(r) for r in conn.execute("SELECT path, op FROM files WHERE event_id=?", (event_id,))]
    return out


def _rel(path: str, cwd: str | None) -> str:
    """Path relative to the session folder, if it is inside it. Works for / and \\ paths on any OS."""
    if not cwd:
        return path
    base = cwd.replace("\\", "/").rstrip("/") + "/"
    norm = path.replace("\\", "/")
    return norm[len(base) :] if norm.startswith(base) else path


def session_detail(conn: sqlite3.Connection, session_id: str) -> dict | None:
    row = conn.execute(f"SELECT {SESSION_COLS} FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        return None
    session = dict(row)
    cwd = session["cwd"]
    events = [
        dict(r)
        for r in conn.execute(
            "SELECT id, kind, category, tool_name, target, summary, started_at, ended_at, duration_ms, status, source"
            " FROM events WHERE session_id=? ORDER BY started_at, id",
            (session_id,),
        )
    ]
    files = [
        {"path": _rel(r["path"], cwd), "op": r["op"], "event_id": r["event_id"]}
        for r in conn.execute("SELECT event_id, path, op FROM files WHERE session_id=?", (session_id,))
    ]
    summary = _summary(events, files)
    return {"session": session, "events": events, "files": files, "summary": summary}


def _top(counter: Counter, n: int = 12) -> list[dict]:
    return [{"name": k, "count": v} for k, v in counter.most_common(n)]


def _summary(events: list[dict], files: list[dict]) -> dict:
    calls = [e for e in events if e["kind"] == "tool_call"]
    written = Counter(f["path"] for f in files if f["op"] in ("write", "delete"))
    read = Counter(f["path"] for f in files if f["op"] == "read")
    commands = Counter(p for e in calls if e["category"] == "bash" and e["target"] for p in programs(e["target"]))
    mcp = Counter(e["target"].split("/")[0] for e in calls if e["category"] == "mcp" and e["target"])
    return {
        "categories": dict(Counter(e["category"] for e in calls)),
        "files_written": _top(written),
        "files_read": _top(read),
        "commands": _top(commands),
        "mcp_servers": _top(mcp),
        "files_written_total": len(written),
        "files_read_total": len(read),
    }
