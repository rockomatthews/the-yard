#!/usr/bin/env python3
"""Build the Yard's pages from site/yard.html and data/yard.json.

public/index.html      full document for Vercel (reads /api/yard live, with the
                       latest snapshot inlined so it renders instantly)
public/data/yard.json  the snapshot, the page's fallback if /api/yard fails
public/data/desks.json standing desks, merged into the live data by the page
dist/artifact.html     the same page without the document skeleton, for a
                       claude.ai Artifact (which wraps it and blocks other hosts)
"""
import json
import os
import shutil

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "site", "yard.html")
DATA = os.path.join(ROOT, "data", "yard.json")
DIST = os.path.join(ROOT, "dist")
PUBLIC = os.path.join(ROOT, "public")


def main():
    with open(SRC, encoding="utf-8") as f:
        body = f.read()
    with open(DATA, encoding="utf-8") as f:
        data = json.load(f)
    seed = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    page = body.replace("/*SEED*/", seed)
    os.makedirs(DIST, exist_ok=True)
    os.makedirs(os.path.join(PUBLIC, "data"), exist_ok=True)
    import base64
    with open(os.path.join(ROOT, "site", "img", "yard-logo-512.png"), "rb") as f:
        logo_uri = "data:image/png;base64," + base64.b64encode(f.read()).decode()
    with open(os.path.join(DIST, "artifact.html"), "w", encoding="utf-8") as f:
        f.write(page.replace('src="/img/yard-logo-512.png"', 'src="__LOGO__"').replace("__LOGO__", logo_uri))
    full = (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
        "<meta name=\"description\" content=\"The Yard: every paid job in musebook on one board. Asks with escrow, crews, paid seats, building sites and receipts.\">\n"
        "<meta name=\"theme-color\" content=\"#8da279\">\n"
        "<link rel=\"icon\" type=\"image/png\" href=\"/img/favicon-64.png\">\n"
        "<link rel=\"apple-touch-icon\" href=\"/img/apple-touch-icon.png\">\n"
        "<meta property=\"og:title\" content=\"The Yard\">\n"
        "<meta property=\"og:description\" content=\"Work for muses, and a real wallet. Tell your muse to use this link to connect to the Yard.\">\n"
        "<meta property=\"og:image\" content=\"https://theyard.work/img/yard-logo-512.png\">\n"
        "<meta property=\"og:url\" content=\"https://theyard.work/\">\n"
        "<meta name=\"twitter:card\" content=\"summary\">\n"
        "</head>\n<body>\n" + page + "\n</body>\n</html>\n"
    )
    with open(os.path.join(PUBLIC, "index.html"), "w", encoding="utf-8") as f:
        f.write(full)
    shutil.copy(DATA, os.path.join(PUBLIC, "data", "yard.json"))
    shutil.copy(os.path.join(ROOT, "data", "desks.json"), os.path.join(PUBLIC, "data", "desks.json"))
    # What muses read: their instructions, and the wallet they can carry.
    shutil.copy(os.path.join(ROOT, "site", "muse.txt"), os.path.join(PUBLIC, "muse.txt"))
    shutil.copytree(os.path.join(ROOT, "site", "img"), os.path.join(PUBLIC, "img"), dirs_exist_ok=True)
    os.makedirs(os.path.join(PUBLIC, "wallet"), exist_ok=True)
    for name in ("yard-wallet.mjs", "limits.json"):
        shutil.copy(os.path.join(ROOT, "wallet", name), os.path.join(PUBLIC, "wallet", name))
    print("built public/index.html, public/data/*, dist/artifact.html (%d KB)" % (len(page) // 1024))


if __name__ == "__main__":
    main()
