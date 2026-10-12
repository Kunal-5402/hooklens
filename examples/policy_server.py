"""A small policy engine for the hooklens policy webhook. Standard library only.

Run it, then point hooklens at it:

    python examples/policy_server.py            # listens on 127.0.0.1:8787
    hooklens policy set http://127.0.0.1:8787/check
    hooklens policy test --command "rm -rf ~"

Each request is a POST with JSON (see design/policy.md). The answer is
{"decision": "allow" | "deny" | "ask", "reason": "..."}. Change RULES to try your own policy.
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# (decision, kind, field, pattern, reason). The first rule that matches wins; no match means allow.
RULES = [
    (
        "deny",
        "tool",
        "target",
        r"\brm\s+-[a-z]*r[a-z]*f?\s+(/|~|\$HOME)(\s|$)",
        "Deleting the home or root folder is not allowed.",
    ),
    (
        "deny",
        "tool",
        "target",
        r"\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b",
        "Piping a download into a shell is not allowed.",
    ),
    ("deny", "tool", "target", r"(^|/)\.env(\.|$)|id_rsa|\.pem$", "Secrets files are off limits."),
    ("ask", "tool", "target", r"\bgit\s+push\b", "Pushing changes a shared branch."),
    ("deny", "prompt", "prompt", r"\bAKIA[0-9A-Z]{16}\b", "The prompt contains an AWS access key."),
]


def decide(request: dict) -> dict:
    for decision, kind, field, pattern, reason in RULES:
        if request.get("event") != kind:
            continue
        value = (request.get("tool") or {}).get(field) if kind == "tool" else request.get(field)
        if isinstance(value, str) and re.search(pattern, value):
            return {"decision": decision, "reason": reason}
    return {"decision": "allow"}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            answer = decide(request)
        except ValueError:
            self.send_error(400, "body must be JSON")
            return
        what = (request.get("tool") or {}).get("target") or request.get("prompt") or ""
        print(f"{answer['decision']:<5} {request.get('agent')} {request.get('event')}: {what[:80]}", flush=True)
        body = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Policy engine on http://127.0.0.1:{server.server_address[1]}/check  (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
