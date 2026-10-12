# Policy webhook

The policy webhook lets a policy engine allow, deny, or ask before a coding agent runs a tool or
sends a prompt. The engine can be your own service, a security product, or the example in
[examples/policy_server.py](../examples/policy_server.py). hooklens sends 1 JSON request, and the
engine sends back 1 decision. hooklens then gives each agent the answer in the form that it expects.

```
agent ──before event──> hooklens hook ──POST JSON──> policy engine
                              │      <──decision────
                              ├──> SQLite (event + decision)
agent <──agent's own format───┘
```

## Set it up

```sh
hooklens policy set https://policy.example.com/check \
  --header 'Authorization: Bearer ${POLICY_TOKEN}' --timeout 2 --fail-closed
hooklens policy test --command "rm -rf ~"     # send a test call and show the decision
hooklens policy show
hooklens policy remove
```

The config is in `~/.hooklens/policy.json`, and only you can read it. Write `${NAME}` in a header
value to read it from the environment variable `NAME` when the hook runs, so the token is not in
the file. A running agent session uses a new or changed policy at once.

| Option | Default | Meaning |
|---|---|---|
| `--timeout` | `2` | Seconds to wait for the engine. The maximum is 8, because the agents stop a hook after 10. |
| `--fail-closed` | off | When the engine fails, deny. Without it, allow. |
| `--header` | none | An HTTP header to send. Use it more than 1 time for more headers. |
| `--no-prompts` | off | Check tool calls only, not prompts. |

## Which events are checked

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Tool call | `PreToolUse` | `PreToolUse` | `preToolUse` |
| Prompt | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` |

Claude Code and Codex already send these events to hooklens. Cursor needs its `preToolUse` hook.
`hooklens policy set` adds that hook, and `hooklens policy remove` removes it again.

Codex sends `PreToolUse` for shell commands, `apply_patch`, and MCP tools, but not for hosted tools
such as web search.

## The request

`POST <url>` with `Content-Type: application/json`:

```json
{
  "version": 1,
  "agent": "claude",
  "event": "tool",
  "hook_event": "PreToolUse",
  "session_id": "0b6f…",
  "cwd": "/home/dev/todo-cli",
  "tool": {
    "name": "Bash",
    "category": "bash",
    "target": "rm -rf ~",
    "input": {"command": "rm -rf ~", "description": "Clean up"}
  },
  "payload": {"…": "the agent's own hook payload"}
}
```

- `event` is `tool` or `prompt`. A prompt request has `"prompt": "<text>"` in place of `tool`.
- `tool.category` is one of `bash`, `file_read`, `file_write`, `search`, `mcp`, `web`, `agent`,
  or `other`. `tool.target` is the command, the path, or the URL that the call acts on. These 2
  fields are the same for all 3 agents, so 1 rule can cover all of them.
- `payload` is what the agent sent, for agent-specific rules. Each string in the payload is cut to
  64 KB, and the Cursor account email is removed.
- `hooklens policy test` adds `"test": true`.

## The response

HTTP 200 with JSON:

```json
{"decision": "deny", "reason": "Deleting the home folder is not allowed."}
```

`decision` is `allow`, `deny`, or `ask`. `reason` is optional, and hooklens keeps the first 1000
characters. Any other answer is a failure: a status that is not 2xx, a timeout, a body that is not
JSON, or a missing or unknown `decision`. On a failure, hooklens uses the `--fail-closed` setting.
A broken `policy.json` always denies, so a policy cannot turn off by accident.

## What each agent does with the decision

| Decision | Claude Code | Codex | Cursor |
|---|---|---|---|
| `allow`, tool | Nothing is printed: Claude Code's own permission rules decide | Nothing is printed: Codex's approval rules decide | `{"permission": "allow"}` |
| `deny`, tool | `permissionDecision: "deny"`. The reason goes to Claude. | `permissionDecision: "deny"` | `{"permission": "deny"}` with the reason |
| `ask`, tool | `permissionDecision: "ask"`. The user sees the reason. | **Deny.** Codex does not support `ask` here. | **Deny.** Cursor does not enforce `ask` here. |
| `deny`, prompt | `{"decision": "block"}`. The user sees the reason. | `{"decision": "block"}` | `{"continue": false}` with the reason |
| `allow` or `ask`, prompt | Nothing is printed | Nothing is printed | `{"continue": true}` |

Notes:

- **`allow` means "no objection".** For Claude Code and Codex, hooklens prints nothing, so their own
  permission rules still apply. A policy can make an agent stricter, but it cannot give the agent
  more permissions.
- **Cursor has no "no opinion" answer** for `preToolUse`. A reply outside its schema blocks the
  tool. So for Cursor, `allow` is an explicit allow.
- **`ask` becomes `deny` where an agent cannot ask the user.** This is the safe choice for a
  security policy. The reason then starts with "Needs approval".
- **`ask` on a prompt allows it.** The user who would approve the prompt is the user who just wrote it.

## What hooklens stores

Each decision is stored with its event, and the UI shows it:

```json
{"decision": "ask", "applied": "deny", "reason": "…", "source": "webhook", "ms": 41}
```

- `decision` is what the engine answered. `applied` is what the agent got.
- `source` is `webhook`, or `error` if the engine failed. For an error, `error` has the cause.
- A tool call or a prompt that was denied gets the status `blocked`. The trace shows a "Blocked"
  badge, and the details panel has a Policy section.

## Speed

Each checked event waits for the engine. The hook is a new process for each event, so it cannot
keep a connection open. On a laptop, a check against a local engine adds about 25 ms to a hook
call. A remote engine also adds a new TCP and TLS connection each time. A local daemon with pooled
connections is planned in [#12](https://github.com/Kunal-5402/hooklens/issues/12).

hooklens reads proxies from `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` only.
