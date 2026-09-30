from __future__ import annotations

import argparse
import getpass
import threading
import webbrowser
from dataclasses import replace
from pathlib import Path

import uvicorn

from .app import create_app
from .config import Settings
from .publisher import GitHubCredentials


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Run the loopback-only Digital Marginalia reviewer")
    result.add_argument("--port", type=int, default=8765)
    result.add_argument("--workspace", type=Path)
    result.add_argument("--ndlocr-config", type=Path)
    result.add_argument("--no-browser", action="store_true")
    result.add_argument("--log-level", default="info", choices=("critical", "error", "warning", "info", "debug"))
    result.add_argument("--set-github-token", metavar="ACCOUNT", help="store a token in Windows Credential Manager and exit")
    return result


def main() -> None:
    args = parser().parse_args()
    settings = Settings.from_env()
    if args.set_github_token:
        if not settings.enable_legacy_github:
            parser.error("legacy GitHub publishing is disabled")
        GitHubCredentials().set_token(args.set_github_token, getpass.getpass("GitHub token: "))
        print(f"Stored GitHub token for {args.set_github_token} in Windows Credential Manager")
        return
    if not 1 <= args.port <= 65535:
        parser().error("--port must be between 1 and 65535")
    if args.workspace is not None:
        settings = replace(settings, workspace=args.workspace)
    if args.ndlocr_config is not None:
        settings = replace(settings, ndlocr_config=args.ndlocr_config)
    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    # Keep an explicit server instance so Desktop's authenticated loopback
    # endpoint can ask Uvicorn for cooperative exit before Windows forceful
    # process-tree cleanup is considered.
    server_holder: list[uvicorn.Server] = []

    def request_desktop_shutdown() -> None:
        if server_holder:
            server_holder[0].should_exit = True

    app = create_app(settings, desktop_shutdown=request_desktop_shutdown)
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level=args.log_level)
    server = uvicorn.Server(config)
    server_holder.append(server)
    server.run()


if __name__ == "__main__":
    main()
