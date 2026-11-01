#!/usr/bin/env python3
"""Export an audited source snapshot without history or workspace secrets."""

import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys


EXCLUDED_DIRECTORIES = {
    ".git", ".agents", ".local", ".cache", "attached_assets",
    "node_modules", "generated-artifacts",
}
PRIVATE_KEY_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
EXTRA_SOURCE_FILES = {
    "README.md",
    "docs/GITHUB_UPLOAD.md",
    "docs/VPS_DEPLOYMENT.md",
    "scripts/export-github-snapshot.py",
}


def exportable(relative_path):
    parts = PurePosixPath(relative_path).parts
    if not parts or any(part in EXCLUDED_DIRECTORIES for part in parts):
        return False
    name = parts[-1]
    if name != ".env.example" and (
        name.endswith(".env") or ".env." in name or ".env_" in name
    ):
        return False
    if name in PRIVATE_KEY_NAMES or name.endswith((".pem", ".key", ".p12", ".pfx")):
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", default="generated-artifacts/nemotron-github-export",
        help="An empty destination under generated-artifacts/",
    )
    args = parser.parse_args()
    root = Path(subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()).resolve()
    output = (root / args.output).resolve()
    generated = (root / "generated-artifacts").resolve()
    if not generated.is_relative_to(root) or not output.is_relative_to(generated) or output == generated:
        parser.error("The output must be a subdirectory of generated-artifacts/.")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        parser.error("The output already exists and is not empty; choose another path.")

    tracked = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"])
    paths = {os.fsdecode(path) for path in tracked.split(b"\0") if path}
    paths.update(path for path in EXTRA_SOURCE_FILES if (root / path).is_file())
    selected = sorted(path for path in paths if exportable(path))

    # Refuse links rather than risk copying a file outside the source checkout.
    for relative in selected:
        source = root / relative
        if source.is_symlink() or not source.resolve().is_relative_to(root):
            parser.error(f"Review this symbolic link before exporting: {relative}")
        if not source.is_file():
            parser.error(f"A tracked source file is missing: {relative}")

    output.mkdir(parents=True, exist_ok=True)
    for relative in selected:
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, destination)

    print(f"Exported {len(selected)} files to {output.relative_to(root)}")
    print("Excluded history, uploads, agent memory, local environment files, and private-key file types.")
    print("Review the remaining source for credentials, then follow docs/GITHUB_UPLOAD.md to push it.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError:
        sys.exit("Git could not read this checkout. Run the helper from the project repository.")
