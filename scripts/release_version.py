#!/usr/bin/env python3
"""Resolve a numeric fnOS release version and stamp build-local metadata."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess

VERSION = re.compile(r"(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")


def parse_version(value: str) -> tuple[int, int, int]:
    match = VERSION.fullmatch(value.strip())
    if not match:
        raise ValueError(f"Invalid release version: {value!r}")
    return tuple(int(part) for part in match.groups())


def valid_versions(tags: list[str]) -> list[tuple[int, int, int]]:
    versions = []
    for tag in tags:
        try:
            versions.append(parse_version(tag))
        except ValueError:
            continue
    return versions


def resolve_version(declared: str, tags: list[str], requested: str = "", ref_type: str = "branch", ref_name: str = "main", head_tags: list[str] | None = None) -> str:
    if requested.strip():
        chosen = parse_version(requested)
    elif ref_type == "tag":
        chosen = parse_version(ref_name)
    elif valid_versions(head_tags or []):
        chosen = max(valid_versions(head_tags or []))
    else:
        chosen = parse_version(declared)
        released = valid_versions(tags)
        if released and chosen <= max(released):
            major, minor, patch = max(released)
            chosen = major, minor, patch + 1
    return ".".join(str(part) for part in chosen)


def stamp_version(root: Path, version: str) -> None:
    parse_version(version)
    manifest = root / "manifest"
    text, count = re.subn(r"(?m)^version\s*=.*$", f"version = {version}", manifest.read_text(encoding="utf-8"))
    if count != 1:
        raise ValueError("Expected exactly one version entry in manifest")
    manifest.write_text(text, encoding="utf-8")
    for name in ("package.json", "package-lock.json"):
        path = root / "app" / "server" / name
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        data["version"] = version
        if isinstance(data.get("packages", {}).get(""), dict):
            data["packages"][""]["version"] = version
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    match = re.search(r"(?m)^version\s*=\s*(\S+)\s*$", (root / "manifest").read_text(encoding="utf-8"))
    if not match:
        raise ValueError("Missing manifest version")
    tags = subprocess.check_output(["git", "tag", "--list"], cwd=root, text=True).splitlines()
    head_tags = subprocess.check_output(["git", "tag", "--points-at", "HEAD"], cwd=root, text=True).splitlines()
    version = resolve_version(match.group(1), tags, os.environ.get("REQUESTED_VERSION", ""), os.environ.get("GITHUB_REF_TYPE", "branch"), os.environ.get("GITHUB_REF_NAME", "main"), head_tags)
    stamp_version(root, version)
    print(version)


if __name__ == "__main__":
    main()
