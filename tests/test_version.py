from importlib.metadata import version

import hooklens


def test_package_version_comes_from_init():
    assert version("hooklens") == hooklens.__version__
