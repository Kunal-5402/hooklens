import json

import pytest

from hooklens import db, hook


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Point every hooklens path at a temp dir, so tests never touch real agent configs."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))  # Path.home(), for the legacy observe paths
    monkeypatch.setenv("HOOKLENS_HOME", str(tmp_path / "hooklens"))
    monkeypatch.setenv("HOOKLENS_CLAUDE_SETTINGS", str(tmp_path / "claude" / "settings.json"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.setenv("HOOKLENS_CURSOR_HOME", str(tmp_path / "cursor"))
    return tmp_path


@pytest.fixture
def conn():
    c = db.connect()
    yield c
    c.close()


@pytest.fixture
def send(monkeypatch):
    """Record a hook payload at a fixed clock time, the way the agent would."""

    def _send(agent: str, payload: dict, at: float) -> None:
        monkeypatch.setattr(hook.time, "time", lambda: at)
        hook.record(agent, json.dumps(payload).encode())

    return _send
