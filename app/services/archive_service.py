"""
archive_service.py

Handles safe extraction of .zip and .rar archives.

Security principles applied:
  - Reject absolute paths in member names.
  - Reject path traversal sequences ("../", "..\").
  - Resolve each destination path and assert it stays inside extract_dir.
  - Enforce a maximum file count and total uncompressed size (zip-bomb guard).
  - Strip dangerous characters from filenames.

Public API:
    extract(archive_path, extract_dir)  → ExtractionResult
"""

from __future__ import annotations

import os
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

# rarfile is optional — we handle ImportError gracefully.
try:
    import rarfile  # requires system `unrar` binary
    _RARFILE_AVAILABLE = True
except ImportError:
    _RARFILE_AVAILABLE = False


# ------------------------------------------------------------------ #
# Constants / limits
# ------------------------------------------------------------------ #

MAX_MEMBER_COUNT = 2_000          # refuse archives with more than this many entries
MAX_UNCOMPRESSED_BYTES = 2 << 30  # 2 GB uncompressed size ceiling
SAFE_FILENAME_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    "._- ()"
)


# ------------------------------------------------------------------ #
# Result type
# ------------------------------------------------------------------ #

@dataclass
class ExtractionResult:
    success: bool
    extracted_dir: Path
    files: list[Path] = field(default_factory=list)    # absolute paths
    error: str | None = None
    warnings: list[str] = field(default_factory=list)


# ------------------------------------------------------------------ #
# Public entry point
# ------------------------------------------------------------------ #

def extract(archive_path: Path, extract_dir: Path) -> ExtractionResult:
    """
    Extract *archive_path* into *extract_dir* safely.

    Supports .zip (always) and .rar (when rarfile + system unrar are present).

    Returns an ExtractionResult regardless of outcome — callers check `.success`.
    """
    extract_dir.mkdir(parents=True, exist_ok=True)
    suffix = archive_path.suffix.lower()

    if suffix == ".zip":
        return _extract_zip(archive_path, extract_dir)
    elif suffix == ".rar":
        return _extract_rar(archive_path, extract_dir)
    else:
        return ExtractionResult(
            success=False,
            extracted_dir=extract_dir,
            error=f"Unsupported archive format: '{suffix}'. Use .zip or .rar.",
        )


# ------------------------------------------------------------------ #
# ZIP extraction
# ------------------------------------------------------------------ #

def _extract_zip(archive_path: Path, extract_dir: Path) -> ExtractionResult:
    warnings: list[str] = []
    extracted_files: list[Path] = []

    try:
        with zipfile.ZipFile(archive_path, "r") as zf:
            members = zf.infolist()

            # ---- Zip-bomb: member count ceiling ----
            if len(members) > MAX_MEMBER_COUNT:
                return ExtractionResult(
                    success=False,
                    extracted_dir=extract_dir,
                    error=(
                        f"Archive contains {len(members)} entries, "
                        f"which exceeds the limit of {MAX_MEMBER_COUNT}."
                    ),
                )

            # ---- Zip-bomb: uncompressed size ceiling ----
            total_size = sum(m.file_size for m in members)
            if total_size > MAX_UNCOMPRESSED_BYTES:
                return ExtractionResult(
                    success=False,
                    extracted_dir=extract_dir,
                    error=(
                        f"Archive would unpack to "
                        f"{total_size / (1 << 30):.1f} GB, "
                        f"which exceeds the 2 GB limit."
                    ),
                )

            for member in members:
                safe_name, warn = _safe_member_name(member.filename)
                if warn:
                    warnings.append(warn)
                if safe_name is None:
                    # Skip dangerous member entirely.
                    continue

                dest = extract_dir / safe_name
                # Resolve and verify containment.
                try:
                    resolved = dest.resolve()
                    extract_resolved = extract_dir.resolve()
                    resolved.relative_to(extract_resolved)
                except ValueError:
                    warnings.append(
                        f"Skipped path-traversal attempt: {member.filename!r}"
                    )
                    continue

                # Directories: just create them.
                if member.filename.endswith("/"):
                    resolved.mkdir(parents=True, exist_ok=True)
                    continue

                # Files: stream to disk (avoid loading huge members into RAM).
                resolved.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(resolved, "wb") as dst:
                    shutil.copyfileobj(src, dst, length=1024 * 1024)
                extracted_files.append(resolved)

    except zipfile.BadZipFile as exc:
        return ExtractionResult(
            success=False,
            extracted_dir=extract_dir,
            error=f"Invalid or corrupted ZIP file: {exc}",
        )
    except Exception as exc:
        return ExtractionResult(
            success=False,
            extracted_dir=extract_dir,
            error=f"Extraction failed: {exc}",
        )

    return ExtractionResult(
        success=True,
        extracted_dir=extract_dir,
        files=extracted_files,
        warnings=warnings,
    )


# ------------------------------------------------------------------ #
# RAR extraction
# ------------------------------------------------------------------ #

def _extract_rar(archive_path: Path, extract_dir: Path) -> ExtractionResult:
    if not _RARFILE_AVAILABLE:
        return ExtractionResult(
            success=False,
            extracted_dir=extract_dir,
            error=(
                "RAR support is not available. "
                "Install the 'rarfile' Python package and the system 'unrar' binary: "
                "  pip install rarfile  &&  apt install unrar  (or brew install rar)"
            ),
        )

    warnings: list[str] = []
    extracted_files: list[Path] = []

    try:
        with rarfile.RarFile(str(archive_path)) as rf:
            members = rf.infolist()

            if len(members) > MAX_MEMBER_COUNT:
                return ExtractionResult(
                    success=False,
                    extracted_dir=extract_dir,
                    error=(
                        f"Archive contains {len(members)} entries, "
                        f"exceeding limit of {MAX_MEMBER_COUNT}."
                    ),
                )

            for member in members:
                safe_name, warn = _safe_member_name(member.filename)
                if warn:
                    warnings.append(warn)
                if safe_name is None:
                    continue

                dest = extract_dir / safe_name
                try:
                    resolved = dest.resolve()
                    resolved.relative_to(extract_dir.resolve())
                except ValueError:
                    warnings.append(
                        f"Skipped path-traversal attempt: {member.filename!r}"
                    )
                    continue

                if member.is_dir():
                    resolved.mkdir(parents=True, exist_ok=True)
                    continue

                resolved.parent.mkdir(parents=True, exist_ok=True)
                rf.extract(member, str(extract_dir))
                # rarfile extracts to the full relative path; relocate if needed.
                naturally_extracted = extract_dir / member.filename
                if naturally_extracted.exists() and naturally_extracted != resolved:
                    naturally_extracted.rename(resolved)
                extracted_files.append(resolved)

    except Exception as exc:
        return ExtractionResult(
            success=False,
            extracted_dir=extract_dir,
            error=f"RAR extraction failed: {exc}",
        )

    return ExtractionResult(
        success=True,
        extracted_dir=extract_dir,
        files=extracted_files,
        warnings=warnings,
    )


# ------------------------------------------------------------------ #
# Name sanitisation
# ------------------------------------------------------------------ #

def _safe_member_name(raw_name: str) -> tuple[str | None, str | None]:
    """
    Sanitise a member filename from an archive.

    Returns (safe_name, warning_or_None).
    Returns (None, warning) when the entry should be skipped entirely.
    """
    # Normalise separators.
    name = raw_name.replace("\\", "/").strip("/")

    # Reject absolute paths.
    if os.path.isabs(raw_name) or raw_name.startswith("/"):
        return None, f"Skipped absolute path: {raw_name!r}"

    # Reject traversal sequences in any path component.
    parts = Path(name).parts
    if any(part in (".", "..") for part in parts):
        return None, f"Skipped path with traversal: {raw_name!r}"

    # Sanitise individual filename (last component).
    *dirs, fname = parts if parts else ([], raw_name)
    safe_fname = _sanitise_filename(fname)
    if not safe_fname:
        return None, f"Skipped member with unusable filename: {raw_name!r}"

    safe_dirs = [_sanitise_dir_component(d) for d in dirs]
    safe_dirs = [d for d in safe_dirs if d]  # drop empty after sanitising

    safe_path = "/".join(safe_dirs + [safe_fname]) if safe_dirs else safe_fname
    warn = None if safe_path == name else f"Renamed {raw_name!r} → {safe_path!r}"
    return safe_path, warn


def _sanitise_filename(name: str) -> str:
    """Keep only safe characters in a filename, preserving the extension."""
    cleaned = "".join(c if c in SAFE_FILENAME_CHARS else "_" for c in name)
    return cleaned.strip(" .")


def _sanitise_dir_component(name: str) -> str:
    """Sanitise a single directory component."""
    cleaned = "".join(c if c in SAFE_FILENAME_CHARS else "_" for c in name)
    return cleaned.strip(" .")
