#!/usr/bin/env python3
"""Ack Cursor ACP authenticate without starting a browser login.

T3 Code always sends methodId cursor_login. The stock CLI then tries to open a
browser even when CURSOR_API_KEY is already sufficient for session/new and
cursor/list_available_models. This filter answers authenticate with an empty
result and forwards every other NDJSON message.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: cursor-acp-api-key-auth <cursor-agent> [args...]", file=sys.stderr)
        return 2

    agent = subprocess.Popen(
        sys.argv[1:],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
    )
    assert agent.stdin is not None
    assert agent.stdout is not None

    def pump_stdout() -> None:
        assert agent.stdout is not None
        while True:
            line = agent.stdout.readline()
            if not line:
                break
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()

    reader = threading.Thread(target=pump_stdout, daemon=True)
    reader.start()

    try:
        for line in sys.stdin.buffer:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                agent.stdin.write(line)
                agent.stdin.flush()
                continue

            if (
                isinstance(message, dict)
                and message.get("method") == "authenticate"
                and "id" in message
            ):
                reply = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}, separators=(",", ":"))
                sys.stdout.buffer.write(f"{reply}\n".encode())
                sys.stdout.buffer.flush()
                continue

            agent.stdin.write(line)
            agent.stdin.flush()
    finally:
        agent.stdin.close()
        reader.join(timeout=5)
        return agent.wait()


if __name__ == "__main__":
    raise SystemExit(main())
