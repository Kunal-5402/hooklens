"""Remove what observe created, and nothing else.

Only known file names are deleted. The data folder is removed only if it is empty afterwards,
so a wrong OBSERVE_HOME cannot delete other files.
"""

from pathlib import Path

from observe import db, paths

DATA_FILES = ("observe.db", "observe.db-wal", "observe.db-shm", "errors.log")


def data_files() -> list[Path]:
    return [p for p in (paths.home() / name for name in DATA_FILES) if p.exists()]


def delete_data() -> list[Path]:
    removed = []
    for p in data_files():
        p.unlink(missing_ok=True)
        removed.append(p)
    try:
        paths.home().rmdir()
    except OSError:  # missing, or it holds files that observe did not create
        pass
    return removed


def agent_counts(agent: str) -> dict[str, int]:
    if not paths.db_path().exists():
        return {"sessions": 0, "raw_events": 0}
    conn = db.connect()
    try:
        sessions = conn.execute("SELECT COUNT(*) FROM sessions WHERE agent=?", (agent,)).fetchone()[0]
        raw = conn.execute("SELECT COUNT(*) FROM raw_events WHERE agent=?", (agent,)).fetchone()[0]
    finally:
        conn.close()
    return {"sessions": sessions, "raw_events": raw}


def delete_agent_data(agent: str) -> dict[str, int]:
    counts = agent_counts(agent)
    if not any(counts.values()):
        return counts
    conn = db.connect()
    try:
        with conn:
            conn.execute("DELETE FROM files WHERE session_id IN (SELECT id FROM sessions WHERE agent=?)", (agent,))
            conn.execute("DELETE FROM events WHERE agent=?", (agent,))
            conn.execute("DELETE FROM sessions WHERE agent=?", (agent,))
            conn.execute("DELETE FROM raw_events WHERE agent=?", (agent,))
        conn.execute("VACUUM")  # give the disk space back
    finally:
        conn.close()
    return counts
