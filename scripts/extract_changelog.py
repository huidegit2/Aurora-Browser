#!/usr/bin/env python3
"""Print the release notes for a version from CHANGELOG.md.

Usage: python3 scripts/extract_changelog.py 1.0.3
If the version has no section, fall back to a short generic note.
"""
from __future__ import annotations

import re
import sys


def main() -> None:
    version = sys.argv[1].lstrip("v") if len(sys.argv) > 1 else ""
    try:
        text = open("CHANGELOG.md", encoding="utf-8").read()
    except FileNotFoundError:
        text = ""

    pattern = re.compile(
        r"^##\s*\[?" + re.escape(version) + r"\]?[^\n]*\n(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    if match and match.group(1).strip():
        print(match.group(1).strip())
        return

    print(f"极光 Aurora v{version}")
    print()
    print("- 请查看仓库提交记录获取本次变更。")
    print("- ARM64 与 x86_64 双架构安装包已随本版本发布。")


if __name__ == "__main__":
    main()
