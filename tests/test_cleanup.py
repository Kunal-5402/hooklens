import json

import pytest

from hooklens import cli, install, paths


@pytest.fixture
def setup(conn, send):
    """Hooks for Claude Code and Codex, 1 session each, and files that hooklens did not create."""
    settings = paths.claude_settings()
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({"model": "opus"}))
    (settings.parent / "CLAUDE.md").write_text("mine")
    install.install("claude")
    install.install("codex")
    send("claude", {"session_id": "c1", "hook_event_name": "UserPromptSubmit", "prompt": "hi"}, 1.0)
    send("codex", {"session_id": "x1", "hook_event_name": "UserPromptSubmit", "prompt": "hi"}, 2.0)
    assert cli.main(["ingest"]) == 0
    (paths.home() / "notes.txt").write_text("not hooklens's")
    conn.close()


def no_terminal(monkeypatch, answer=None):
    monkeypatch.setattr(cli.sys, "stdin", type("S", (), {"isatty": lambda self: answer is not None})())
    monkeypatch.setattr("builtins.input", lambda prompt: answer)


def sessions():
    from hooklens import db

    c = db.connect()
    try:
        return sorted(r[0] for r in c.execute("SELECT agent FROM sessions"))
    finally:
        c.close()


def test_clear_dry_run_changes_nothing(setup, capsys):
    assert cli.main(["clear", "--dry-run"]) == 0
    assert "Dry run" in capsys.readouterr().out
    assert paths.db_path().exists()


def test_clear_needs_confirmation(setup, monkeypatch, capsys):
    no_terminal(monkeypatch)
    assert cli.main(["clear"]) == 1
    assert "--yes" in capsys.readouterr().err
    assert paths.db_path().exists()

    no_terminal(monkeypatch, answer="n")
    assert cli.main(["clear"]) == 1
    assert paths.db_path().exists()

    def ctrl_d(prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", ctrl_d)
    monkeypatch.setattr(cli.sys, "stdin", type("S", (), {"isatty": lambda self: True})())
    assert cli.main(["clear"]) == 1
    assert paths.db_path().exists()


def test_clear_deletes_only_hooklens_data(setup):
    assert cli.main(["clear", "--yes"]) == 0
    assert not paths.db_path().exists()
    assert (paths.home() / "notes.txt").read_text() == "not hooklens's"
    assert set(install.installed_events("claude")) == set(install.EVENTS["claude"])


def test_agent_clear_keeps_other_agents(setup):
    assert cli.main(["claude", "clear", "--yes"]) == 0
    assert sessions() == ["codex"]


def test_uninstall_keeps_data_and_needs_no_confirmation(setup, monkeypatch):
    no_terminal(monkeypatch)
    assert cli.main(["uninstall"]) == 0
    assert install.installed_events("claude") == []
    assert not paths.codex_hooks().exists()
    assert sessions() == ["claude", "codex"]


def test_purge_removes_everything_hooklens_made_and_nothing_else(setup):
    (paths.home() / "notes.txt").unlink()
    claude_dir = paths.claude_settings().parent

    assert cli.main(["uninstall", "--purge", "--yes"]) == 0

    assert json.loads(paths.claude_settings().read_text()) == {"model": "opus"}
    assert (claude_dir / "CLAUDE.md").read_text() == "mine"
    assert not paths.codex_hooks().exists()
    assert install.backups("claude") == [] and install.backups("codex") == []
    assert not paths.home().exists()  # empty after the data files were deleted


def test_agent_purge_leaves_other_agents(setup):
    assert cli.main(["claude", "uninstall", "--purge", "--yes"]) == 0
    assert install.installed_events("claude") == []
    assert set(install.installed_events("codex")) == set(install.EVENTS["codex"])
    assert sessions() == ["codex"]
    assert install.backups("claude") == []


def test_nothing_to_remove(capsys):
    assert cli.main(["uninstall", "--purge", "--yes"]) == 0
    assert "Nothing to remove" in capsys.readouterr().out
