"""Build a deterministic source/runtime archive after publication gates."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

from privacy_check import report, scan_archive, scan_source, source_paths

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {"README.md", "README.zh-CN.md", "LICENSE", "NOTICE", "SECURITY.md",
              "CONTRIBUTING.md", "CHANGELOG.md", "plugin.json", "mcp.json", ".mcp.json",
              "package.json", "package-lock.json", "tsconfig.json", ".gitignore", ".gitattributes"}
DIRECTORIES = {"src", "test", "scripts", "config", "docs", ".codex-plugin", ".agents", ".github"}


def git(*arguments):
    return subprocess.run(["git", "-C", str(ROOT), *arguments], capture_output=True,
                          text=True, check=True).stdout.strip()


def verify_versions():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    portable = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    overlay = json.loads((ROOT / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
    source = (ROOT / "src/version.ts").read_text(encoding="utf-8")
    if not re.search(r'VERSION = "' + re.escape(package["version"]) + '"', source):
        raise ValueError("SOURCE_VERSION_MISMATCH")
    if any(value["version"] != package["version"] for value in (portable, overlay)):
        raise ValueError("MANIFEST_VERSION_MISMATCH")
    if portable["name"] != overlay["name"] or portable["license"] != package["license"]:
        raise ValueError("MANIFEST_IDENTITY_MISMATCH")
    if portable["extensions"]["com.openai"]["interface"] != overlay["interface"]:
        raise ValueError("MANIFEST_INTERFACE_MISMATCH")
    return package


def canonical_bytes(path):
    return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").encode("utf-8")


def build(preview=False):
    if not preview and git("status", "--porcelain"):
        raise ValueError("CLEAN_COMMITTED_CHECKOUT_REQUIRED")
    package = verify_versions()
    findings = scan_source(ROOT)
    if findings:
        report(findings)
        raise ValueError("SOURCE_PRIVACY_GATE_FAILED")
    npm = "npm.cmd" if os.name == "nt" else "npm"
    subprocess.run([npm, "run", "build"], cwd=ROOT, check=True)
    payload = {}
    for name in source_paths(ROOT):
        if name in ROOT_FILES or name.split("/")[0] in DIRECTORIES:
            payload[name] = canonical_bytes(ROOT / name)
    for path in sorted((ROOT / "dist").rglob("*")):
        if path.is_symlink():
            raise ValueError("BUILD_SYMLINK_REJECTED")
        if path.is_file():
            payload[path.relative_to(ROOT).as_posix()] = canonical_bytes(path)
    commit = "preview" if preview else git("rev-parse", "HEAD")
    metadata = {"name": "ai-data-mcp", "version": package["version"], "source_commit": commit,
                "preview": preview, "files": {name: hashlib.sha256(data).hexdigest()
                                               for name, data in sorted(payload.items())}}
    payload["release.json"] = (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode()
    destination = ROOT / "release"
    destination.mkdir(exist_ok=True)
    target = destination / f'ai-data-mcp-{package["version"]}.zip'
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(payload.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    findings = scan_archive(target)
    if findings:
        target.unlink()
        report(findings)
        raise ValueError("ARCHIVE_PRIVACY_GATE_FAILED")
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (destination / "SHA256SUMS").write_text(f"{digest}  {target.name}\n", encoding="utf-8", newline="\n")
    return target, digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true", help="Uncommitted local preview; never publish")
    args = parser.parse_args()
    try:
        target, digest = build(args.preview)
        print(f"{target.name}: {digest}")
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Packaging failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
