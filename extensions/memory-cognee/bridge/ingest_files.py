#!/usr/bin/env python3
"""
Bulk ingest files into Cognee knowledge graph.

Usage:
    python ingest_files.py /path/to/documents
    python ingest_files.py /path/to/documents --pattern "*.md"
    python ingest_files.py /path/to/documents --recursive
    python ingest_files.py /path/to/documents --cognify

Supported file types:
    .txt, .md, .pdf, .docx, .doc, .csv, .json, .html, .py, .js, .ts, .yaml, .yml
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import List

# Supported file extensions
SUPPORTED_EXTENSIONS = {
    '.txt', '.md', '.markdown',
    '.pdf',
    '.docx', '.doc',
    '.csv',
    '.json',
    '.html', '.htm',
    '.py', '.js', '.ts', '.jsx', '.tsx',
    '.yaml', '.yml',
    '.xml',
    '.rst',
}

def find_files(directory: Path, pattern: str = "*", recursive: bool = False) -> List[Path]:
    """Find all supported files in directory."""
    files = []

    if recursive:
        for ext in SUPPORTED_EXTENSIONS:
            files.extend(directory.rglob(f"*{ext}"))
    else:
        for ext in SUPPORTED_EXTENSIONS:
            files.extend(directory.glob(f"*{ext}"))

    # If pattern specified, filter further
    if pattern != "*":
        import fnmatch
        files = [f for f in files if fnmatch.fnmatch(f.name, pattern)]

    return sorted(set(files))


async def ingest_files(
    directory: str,
    pattern: str = "*",
    recursive: bool = False,
    run_cognify: bool = False,
    bridge_url: str = "http://localhost:8001",
    dry_run: bool = False,
):
    """Ingest all matching files into Cognee."""
    try:
        import httpx
    except ImportError:
        print("Installing httpx...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx"])
        import httpx

    directory_path = Path(directory).resolve()

    if not directory_path.exists():
        print(f"Error: Directory not found: {directory_path}")
        sys.exit(1)

    if not directory_path.is_dir():
        print(f"Error: Not a directory: {directory_path}")
        sys.exit(1)

    # Find files
    files = find_files(directory_path, pattern, recursive)

    if not files:
        print(f"No supported files found in {directory_path}")
        print(f"Supported extensions: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
        sys.exit(0)

    print(f"Found {len(files)} files to ingest:")
    for f in files[:10]:
        print(f"  - {f.relative_to(directory_path)}")
    if len(files) > 10:
        print(f"  ... and {len(files) - 10} more")
    print()

    if dry_run:
        print("Dry run - no files will be ingested.")
        return

    # Check bridge is running
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.get(f"{bridge_url}/health")
            if r.status_code != 200:
                print(f"Error: Bridge not healthy at {bridge_url}")
                sys.exit(1)
            print(f"Bridge is healthy at {bridge_url}")
        except httpx.ConnectError:
            print(f"Error: Cannot connect to bridge at {bridge_url}")
            print("Start the bridge first: python start_server.py")
            sys.exit(1)

        # Ingest each file
        success = 0
        failed = 0

        for i, file_path in enumerate(files, 1):
            try:
                # Read file content
                try:
                    content = file_path.read_text(encoding='utf-8')
                except UnicodeDecodeError:
                    # Try with different encoding
                    try:
                        content = file_path.read_text(encoding='latin-1')
                    except Exception:
                        print(f"  [{i}/{len(files)}] SKIP (binary): {file_path.name}")
                        continue

                if not content.strip():
                    print(f"  [{i}/{len(files)}] SKIP (empty): {file_path.name}")
                    continue

                # Add metadata about source file
                metadata_header = f"[Source: {file_path.name}]\n\n"
                full_content = metadata_header + content

                # Truncate very long files
                max_chars = 50000
                if len(full_content) > max_chars:
                    full_content = full_content[:max_chars] + f"\n\n[Truncated - original was {len(content)} chars]"

                # Send to bridge
                r = await client.post(
                    f"{bridge_url}/add",
                    json={
                        "text": full_content,
                        "source": str(file_path.relative_to(directory_path)),
                    }
                )

                if r.status_code == 200:
                    print(f"  [{i}/{len(files)}] OK: {file_path.name} ({len(content)} chars)")
                    success += 1
                else:
                    print(f"  [{i}/{len(files)}] FAIL: {file_path.name} - {r.text}")
                    failed += 1

            except Exception as e:
                print(f"  [{i}/{len(files)}] ERROR: {file_path.name} - {e}")
                failed += 1

        print()
        print(f"Ingested: {success} files")
        if failed:
            print(f"Failed: {failed} files")

        # Run cognify if requested
        if run_cognify and success > 0:
            print()
            print("Building knowledge graph (cognify)...")
            r = await client.post(
                f"{bridge_url}/cognify",
                json={"full_rebuild": False},
                timeout=300.0,  # 5 min timeout for large datasets
            )
            if r.status_code == 200:
                print("Knowledge graph updated successfully!")
            else:
                print(f"Cognify failed: {r.text}")
        elif success > 0 and not run_cognify:
            print()
            print("Note: Run with --cognify to build the knowledge graph, or run:")
            print(f'  curl -X POST {bridge_url}/cognify -H "Content-Type: application/json" -d \'{{"full_rebuild":false}}\'')


def main():
    parser = argparse.ArgumentParser(
        description="Bulk ingest files into Cognee knowledge graph",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Ingest all files in a directory
    python ingest_files.py ~/Documents/notes

    # Ingest only markdown files
    python ingest_files.py ~/Documents/notes --pattern "*.md"

    # Ingest recursively and build knowledge graph
    python ingest_files.py ~/Documents --recursive --cognify

    # Preview what would be ingested
    python ingest_files.py ~/Documents --recursive --dry-run

Supported file types:
    Text: .txt, .md, .markdown, .rst
    Documents: .pdf, .docx, .doc
    Data: .csv, .json, .yaml, .yml, .xml
    Code: .py, .js, .ts, .jsx, .tsx
    Web: .html, .htm
        """
    )

    parser.add_argument("directory", help="Directory containing files to ingest")
    parser.add_argument("--pattern", default="*", help="File pattern to match (e.g., '*.md')")
    parser.add_argument("--recursive", "-r", action="store_true", help="Search subdirectories")
    parser.add_argument("--cognify", "-c", action="store_true", help="Build knowledge graph after ingestion")
    parser.add_argument("--bridge-url", default="http://localhost:8001", help="Cognee bridge URL")
    parser.add_argument("--dry-run", "-n", action="store_true", help="Show what would be ingested without doing it")

    args = parser.parse_args()

    asyncio.run(ingest_files(
        directory=args.directory,
        pattern=args.pattern,
        recursive=args.recursive,
        run_cognify=args.cognify,
        bridge_url=args.bridge_url,
        dry_run=args.dry_run,
    ))


if __name__ == "__main__":
    main()
