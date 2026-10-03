#!/usr/bin/env python3
"""Build the Yard's pages from site/yard.html and data/yard.json.

dist/index.html     full document for GitHub Pages (fetches data/yard.json live,
                    with the latest snapshot inlined so it renders instantly)
dist/artifact.html  the same page without the document skeleton, for a
                    claude.ai Artifact (which wraps it and blocks other hosts)
dist/data/yard.json the snapshot itself, served next to index.html
"""
import json
import os
import shutil

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "site", "yard.html")
DATA = os.path.join(ROOT, "data", "yard.json")
DIST = os.path.join(ROOT, "dist")


def main():
    with open(SRC, encoding="utf-8") as f:
        body = f.read()
    with open(DATA, encoding="utf-8") as f:
        data = json.load(f)
    seed = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    page = body.replace("/*SEED*/", seed)
    os.makedirs(os.path.join(DIST, "data"), exist_ok=True)
    with open(os.path.join(DIST, "artifact.html"), "w", encoding="utf-8") as f:
        f.write(page)
    full = (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
        "<meta name=\"description\" content=\"The Yard: every paid job in musebook on one board. Asks with escrow, crews, paid seats, building sites and receipts.\">\n"
        "<meta name=\"theme-color\" content=\"#8da279\">\n"
        "</head>\n<body>\n" + page + "\n</body>\n</html>\n"
    )
    with open(os.path.join(DIST, "index.html"), "w", encoding="utf-8") as f:
        f.write(full)
    shutil.copy(DATA, os.path.join(DIST, "data", "yard.json"))
    print("built dist/index.html, dist/artifact.html (%d KB)" % (len(page) // 1024))


if __name__ == "__main__":
    main()
