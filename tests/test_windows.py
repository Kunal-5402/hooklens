"""Windows support that can be tested on any OS."""

from hooklens import install
from hooklens.queries import _rel


def test_unix_path_is_shell_quoted():
    assert install.python_command("/opt/my tools/python", windows=False) == "'/opt/my tools/python'"
    assert install.python_command("/usr/bin/python3", windows=False) == "/usr/bin/python3"


def test_windows_path_uses_forward_slashes_and_no_quotes():
    exe = r"C:\Users\kunal\AppData\Roaming\uv\tools\hooklens\Scripts\python.exe"
    assert (
        install.python_command(exe, windows=True)
        == "C:/Users/kunal/AppData/Roaming/uv/tools/hooklens/Scripts/python.exe"
    )


def test_windows_path_with_a_space_uses_the_short_path(monkeypatch):
    monkeypatch.setattr(install, "_short_path", lambda p: r"C:\Users\JOHNSM~1\python.exe")
    assert install.python_command(r"C:\Users\John Smith\python.exe", windows=True) == "C:/Users/JOHNSM~1/python.exe"


def test_windows_path_with_a_space_is_quoted_without_a_short_path(monkeypatch):
    monkeypatch.setattr(install, "_short_path", lambda p: p)
    assert install.python_command(r"C:\Users\John Smith\python.exe", windows=True) == '"C:/Users/John Smith/python.exe"'


def test_rel_works_for_posix_and_windows_paths():
    assert _rel("/repo/src/a.py", "/repo") == "src/a.py"
    assert _rel(r"C:\repo\src\a.py", "C:\\repo") == "src/a.py"
    assert _rel("/other/a.py", "/repo") == "/other/a.py"
    assert _rel("/repository/a.py", "/repo") == "/repository/a.py"
    assert _rel("/repo/a.py", None) == "/repo/a.py"
