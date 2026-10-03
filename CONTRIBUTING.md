# Contributing to hooklens

Thanks for your interest in hooklens! Bug reports, ideas, docs, and code are all welcome.

## Ways to help

- **Report a bug.** Open an issue with the output of `hooklens doctor`, your OS, and the agent
  and its version (Claude Code, Codex, or Cursor).
- **Suggest a feature.** Open an issue that describes the problem first, then your idea.
- **Pick an issue.** Issues labeled [`good first issue`](https://github.com/Kunal-5402/hooklens/labels/good%20first%20issue)
  are a good start. Comment on the issue before you start, so that two people do not do the same work.
- **Improve the docs.** Small fixes are welcome without an issue.

## Development setup

You need [uv](https://docs.astral.sh/uv/) and Python 3.11 or later.

```sh
git clone https://github.com/Kunal-5402/hooklens.git
cd hooklens
make setup     # create .venv with the dev dependencies
make check     # lint, format check, and tests: the same checks as CI
make show      # open the UI from your dev env
```

Run `make help` to see every target, and `make format` to format your code.

To try your changes with a real agent, install your working copy and add the hooks:

```sh
make install                # uv tool install --force . && hooklens install
hooklens uninstall --purge  # when you are done
```

## How the code is organized

Read [design/architecture.md](design/architecture.md) first. It explains the parts, the data
model, and why the code works the way it does. [design/sequence.md](design/sequence.md) shows the
full call flow.

## Rules for the code

- **No runtime dependencies.** hooklens uses only the Python standard library, so it installs
  anywhere. Dev tools (pytest, ruff) are fine.
- **The hook must stay fast and safe.** It runs inside the agent on every event. It must not parse
  much, must not print to stdout for Claude Code and Codex, must always print a no-op JSON reply
  for Cursor, and must always exit 0. Measure the hook time if you change `hook.py`.
- **Never subscribe to hooks that decide.** hooklens only reports. It must never allow, block, or
  change an agent action.
- **Agent differences belong in `adapters.py`, `install.py`, and `normalize.py`.** The rest of the
  code and the UI do not know which agent sent an event.
- **The UI is plain HTML, CSS, and JavaScript.** No build step and no external libraries.
- **Style:** `ruff` enforces lint and formatting, with a line length of 120.

## Tests

- Add tests for every change in behavior. Tests live in `tests/`.
- Tests must never touch real agent configs or your real data. `tests/conftest.py` points every
  path to a temporary folder through the `HOOKLENS_*` environment variables, `CODEX_HOME`, and
  `HOME`. Use the `conn` and `send` fixtures to record hook events.
- If you change an adapter, add a real hook payload from that agent as a test case when you can.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each PR focused on one change. Small PRs are reviewed faster.
3. Write short commit messages (1 line, plus an optional second line for the reason).
4. Run `make check` before you push.
5. Open the PR with a short description of what changed and why. Link the issue (for example `Closes #123`).
6. Update `README.md` or `design/` if your change affects them.

Every PR needs passing CI checks (`lint`, `format`, `test` on Python 3.11 to 3.13) and an approval
from the maintainer. For a PR from a fork, a maintainer approves the CI run first.

## Security issues

Do not open a public issue for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability**.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
