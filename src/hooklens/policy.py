"""Policy webhook: ask a policy engine to allow, deny, or ask before an agent acts.

The hook calls the webhook only for "before" events (a tool call or a prompt), and only when a
policy is configured in ~/.hooklens/policy.json. The engine gets 1 JSON request and returns
{"decision": "allow" | "deny" | "ask", "reason": "..."}. `reply` turns the decision into the
answer that each agent expects.

"allow" means "no objection": the agent's own permission rules still apply. So a policy can only
make an agent stricter, never give it more permissions.
"""

import json
import os
import re
import time

from hooklens import __version__, paths

DECISIONS = ("allow", "deny", "ask")
DEFAULT_TIMEOUT = 2.0
MAX_TIMEOUT = 8.0  # the agents stop a hook after 10 seconds, and the hook needs time to reply
MAX_RESPONSE = 64 * 1024
ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
KEY = "_hooklens_policy"  # where the decision is stored in the recorded payload


# ---------- config ----------


def load() -> dict | None:
    """The policy config, or None if no policy is set. Raises ValueError for a broken file."""
    try:
        with open(paths.policy_config()) as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        return None
    if not isinstance(cfg, dict) or not isinstance(cfg.get("url"), str) or not cfg["url"]:
        raise ValueError(f"{paths.policy_config()} has no webhook url")
    return cfg


def make_config(url: str, timeout: float, fail_closed: bool, headers: dict[str, str], prompts: bool) -> dict:
    if not re.match(r"https?://", url):
        raise ValueError("the webhook url must start with http:// or https://")
    if not 0 < timeout <= MAX_TIMEOUT:
        raise ValueError(f"the timeout must be more than 0 and at most {MAX_TIMEOUT:g} seconds")
    return {
        "url": url,
        "timeout": timeout,
        "on_error": "deny" if fail_closed else "allow",
        "headers": headers,
        "prompts": prompts,
    }


def save(cfg: dict) -> None:
    """Write the config readable by the owner only, because headers can hold a token."""
    import tempfile

    path = paths.policy_config()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".policy.")
    with os.fdopen(fd, "w") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def remove() -> bool:
    try:
        paths.policy_config().unlink()
    except FileNotFoundError:
        return False
    return True


def expand(value: str) -> str:
    """Replace ${NAME} with the environment variable NAME, so a token does not have to be in the file."""
    return ENV_REF.sub(lambda m: os.environ.get(m.group(1), ""), value)


def timeout(cfg: dict) -> float:
    try:
        value = float(cfg.get("timeout", DEFAULT_TIMEOUT))
    except (TypeError, ValueError):
        value = DEFAULT_TIMEOUT
    return min(max(value, 0.1), MAX_TIMEOUT)


def on_error(cfg: dict | None) -> str:
    return "deny" if cfg is None or cfg.get("on_error") == "deny" else "allow"


# ---------- the webhook call ----------


def call(cfg: dict, request: dict) -> tuple[str, str]:
    """POST the request to the webhook. Returns (decision, reason). Raises on any failure."""
    import urllib.request  # only here: it is slow to import, and most hook calls do not need it

    headers = {"Content-Type": "application/json", "User-Agent": f"hooklens/{__version__}"}
    headers |= {str(k): expand(str(v)) for k, v in (cfg.get("headers") or {}).items()}
    req = urllib.request.Request(cfg["url"], data=json.dumps(request).encode(), headers=headers, method="POST")
    # Proxies come from HTTPS_PROXY, HTTP_PROXY, and NO_PROXY only: the macOS system proxy lookup is slow.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies_environment()))
    with opener.open(req, timeout=timeout(cfg)) as resp:
        data = json.loads(resp.read(MAX_RESPONSE) or b"null")
    if not isinstance(data, dict) or data.get("decision") not in DECISIONS:
        raise ValueError('the response has no "decision" of allow, deny, or ask')
    reason = data.get("reason")
    return data["decision"], str(reason)[:1000] if reason else ""


def decide(cfg: dict | None, request: dict) -> dict:
    """Ask the engine. Never raises: a failure gives the configured on_error decision."""
    start = time.monotonic()
    try:
        if cfg is None:
            raise ValueError(f"cannot read {paths.policy_config()}")
        decision, reason = call(cfg, request)
        result = {"decision": decision, "reason": reason, "source": "webhook"}
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"[:300]
        decision = on_error(cfg)
        result = {
            "decision": decision,
            "reason": f"Policy engine unavailable ({error})",
            "source": "error",
            "error": error,
        }
    result["ms"] = round((time.monotonic() - start) * 1000)
    return result


# ---------- requests and replies ----------

# The "before" events that the policy checks, for each agent: event name -> "tool" or "prompt".
GATES = {
    "claude": {"PreToolUse": "tool", "UserPromptSubmit": "prompt"},
    "codex": {"PreToolUse": "tool", "UserPromptSubmit": "prompt"},
    "cursor": {"preToolUse": "tool", "beforeSubmitPrompt": "prompt"},
}
REQUEST_FIELD_LIMIT = 64 * 1024
DEFAULT_REASONS = {"deny": "Blocked by the policy engine.", "ask": "The policy engine asks for your approval."}
AGENT_NAMES = {"claude": "Claude Code", "codex": "Codex", "cursor": "Cursor"}


def applied(agent: str, kind: str, decision: str) -> str:
    """The decision that the agent can carry out.

    A prompt cannot be sent for approval: the user who would approve it just wrote it, so "ask"
    lets it through. For a tool, only Claude Code can ask the user. Codex and Cursor do not
    enforce "ask" for this event and would run the tool, so hooklens denies it instead.
    """
    if decision == "ask":
        return "allow" if kind == "prompt" else "ask" if agent == "claude" else "deny"
    return decision


def build_request(agent: str, kind: str, payload: dict) -> dict:
    from hooklens.hook import session_key, truncate

    payload = truncate({k: v for k, v in payload.items() if k != "user_email"}, REQUEST_FIELD_LIMIT)
    roots = payload.get("workspace_roots")
    request = {
        "version": 1,
        "agent": agent,
        "event": kind,
        "hook_event": payload.get("hook_event_name"),
        "session_id": session_key(payload),
        "cwd": payload.get("cwd") or (roots[0] if isinstance(roots, list) and roots else None),
    }
    if kind == "prompt":
        request["prompt"] = payload.get("prompt") or ""
    else:
        name, tool_input = payload.get("tool_name"), payload.get("tool_input")
        try:
            from hooklens.adapters import classify

            info = classify(name, tool_input)
            category, target = info.category, info.target
        except Exception:  # a parser bug must not stop the decision
            category, target = None, None
        request["tool"] = {"name": name, "category": category, "target": target, "input": tool_input}
    request["payload"] = payload
    return request


def check(agent: str, raw: bytes) -> tuple[str, dict] | None:
    """Ask the policy engine about one hook event. None if the event is not checked."""
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    kind = GATES.get(agent, {}).get(payload.get("hook_event_name"))
    if not kind:
        return None
    try:
        cfg = load()
    except (OSError, ValueError):
        cfg = None  # a broken config fails closed: the policy must not turn off by accident
    else:
        if cfg is None or (kind == "prompt" and not cfg.get("prompts", True)):
            return None
    result = decide(cfg, build_request(agent, kind, payload))
    result["applied"] = applied(agent, kind, result["decision"])
    return kind, result


def reply(agent: str, kind: str, result: dict) -> str | None:
    """The hook's stdout for this decision, or None to print nothing."""
    decision = result.get("applied") or result["decision"]
    reason = result.get("reason") or DEFAULT_REASONS.get(decision, "")
    if decision == "deny" and result["decision"] == "ask":
        reason = f"Needs approval, which {AGENT_NAMES.get(agent, agent)} cannot ask for here. {reason}"
    if kind == "prompt":
        if agent == "cursor":
            return json.dumps({"continue": False, "user_message": reason} if decision == "deny" else {"continue": True})
        return json.dumps({"decision": "block", "reason": reason}) if decision == "deny" else None
    if agent == "cursor":
        # Cursor has no "no opinion" answer for this event: a reply outside its schema blocks the tool.
        if decision == "deny":
            return json.dumps({"permission": "deny", "user_message": reason, "agent_message": reason})
        return json.dumps({"permission": "allow"})
    if decision == "allow":
        return None  # print nothing, so the agent's own permission rules still apply
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": decision,
                "permissionDecisionReason": reason,
            }
        }
    )
