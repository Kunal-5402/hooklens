"""hooklens was called observe before. Old installs must keep working after the rename."""

import json
import sqlite3

from hooklens import cli, db, install, paths

OLD_COMMAND = "/old/venv/bin/python -m observe claude hook"


def test_install_replaces_old_observe_hooks():
    settings = paths.claude_settings()
    settings.parent.mkdir(parents=True)
    old = {"hooks": [{"type": "command", "command": OLD_COMMAND}]}
    settings.write_text(json.dumps({"hooks": {"Stop": [old]}}))
    (settings.parent / "settings.json.observe-backup-20260925-160303").write_text("{}")

    install.install("claude")
    stop = json.loads(settings.read_text())["hooks"]["Stop"]
    assert len(stop) == 1 and "-m hooklens claude hook" in stop[0]["hooks"][0]["command"]
    assert any(b.name.endswith("observe-backup-20260925-160303") for b in install.backups("claude"))

    _, removed, _ = install.uninstall("claude")
    assert removed == len(install.EVENTS["claude"])


def test_install_copies_old_observe_data(capsys):
    old = paths.legacy_db_path()
    old.parent.mkdir(parents=True)
    conn = sqlite3.connect(old)
    conn.execute("CREATE TABLE t (x)")
    conn.execute("INSERT INTO t VALUES (42)")
    conn.commit()
    conn.close()

    assert cli.main(["claude", "install"]) == 0
    assert "Copied your observe data" in capsys.readouterr().out
    copy = sqlite3.connect(paths.db_path())
    assert copy.execute("SELECT x FROM t").fetchone() == (42,)
    copy.close()
    assert old.exists()  # the old data stays
    assert db.copy_legacy() is None  # never copies twice
