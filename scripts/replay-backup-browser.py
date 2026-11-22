"""Run an offline backup regression with existing Playwright and Chromium.

Example (from the repo root):
  CHROMIUM_PATH=/path/to/chromium python scripts/replay-backup-browser.py export-snapshot
Use backup-limits instead for the book-count replay.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", choices=["export-snapshot", "backup-limits"])
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    url = "http://127.0.0.1/replay"
    with tempfile.TemporaryDirectory(prefix="better-epub-replay-") as work:
        work = Path(work)
        script = work / "replay.js"
        subprocess.run(
            [
                str(source / "node_modules" / ".bin" / "esbuild"),
                f"scripts/{args.case}.replay.js",
                "--bundle",
                '--define:import.meta.env.BASE_URL="/"',
                "--platform=browser",
                "--format=iife",
                "--global-name=Replay",
                f"--outfile={script}",
            ],
            cwd=source,
            check=True,
        )

        def route(request):
            if request.request.url == url:
                request.fulfill(content_type="text/html", body="<title>Offline backup replay</title>")
            else:
                request.abort()

        with sync_playwright() as driver:
            browser = driver.chromium.launch_persistent_context(
                str(work / "profile"),
                executable_path=os.environ.get("CHROMIUM_PATH") or None,
                headless=True,
                args=["--disable-background-networking", "--disable-breakpad", "--disable-crash-reporter", "--disable-dev-shm-usage"],
            )
            browser.route("**/*", route)
            page = browser.pages[0]
            page.goto(url)
            page.add_script_tag(content=script.read_text())
            print(page.evaluate("navigator.userAgent"))
            result = page.evaluate("Replay.replay()")
            print(json.dumps(result, indent=2))
            browser.close()
        return 0 if result.get("pass", result.get("passed", False)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
