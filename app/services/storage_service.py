"""
storage_service.py

Manages the on-disk layout for each uploaded model package.

Layout per model:
    uploads/
      <uuid>/
        raw/
          original_filename.zip   ← original archive (kept for audit)
        extracted/
          ...all extracted files...
        meta.json                 ← written after extraction + inspection

This module only deals with folder creation and the raw save;
extraction and inspection live in archive_service and model_service.
"""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from flask import current_app


# ------------------------------------------------------------------ #
# Public helpers
# ------------------------------------------------------------------ #

def new_model_id() -> str:
    """Generate a unique model identifier (UUID4 string)."""
    return str(uuid.uuid4())


def model_dir(model_id: str) -> Path:
    """Return the root directory for a model (created if absent)."""
    base: Path = current_app.config["UPLOAD_FOLDER"]
    path = base / model_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def raw_dir(model_id: str) -> Path:
    """Directory that holds the original, untouched archive."""
    d = model_dir(model_id) / "raw"
    d.mkdir(parents=True, exist_ok=True)
    return d


def extracted_dir(model_id: str) -> Path:
    """Directory where the archive contents are extracted."""
    d = model_dir(model_id) / "extracted"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_raw_archive(model_id: str, fileobj, filename: str) -> Path:
    """
    Save the uploaded file object to raw/<safe_filename>.

    Args:
        model_id: The UUID for this upload.
        fileobj:  A file-like object (Werkzeug FileStorage).
        filename: The original filename (will be sanitised).

    Returns:
        Path to the saved archive.
    """
    from werkzeug.utils import secure_filename

    safe_name = secure_filename(filename) or "upload.bin"
    dest = raw_dir(model_id) / safe_name
    fileobj.save(str(dest))
    return dest


def place_direct_model(model_id: str, raw_path: Path) -> tuple[Path, list[dict]]:
    """
    Copy a single uploaded model file into extracted/ for the viewer.

    Returns:
        (extract_dir, file_entries) where file_entries matches the
        shape used by archive extraction meta.
    """
    extract = extracted_dir(model_id)
    dest = extract / raw_path.name
    shutil.copy2(raw_path, dest)
    size = dest.stat().st_size if dest.exists() else 0
    return extract, [{"path": dest.name, "size": size}]


def write_meta(model_id: str, data: dict[str, Any]) -> Path:
    """
    Serialise *data* as JSON to uploads/<model_id>/meta.json.

    Always merges — existing keys are preserved unless overwritten.
    """
    path = model_dir(model_id) / "meta.json"
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    existing.update(data)
    path.write_text(json.dumps(existing, indent=2))
    return path


def read_meta(model_id: str) -> dict[str, Any] | None:
    """
    Read meta.json for the given model_id.

    Returns None if the model doesn't exist or meta is unreadable.
    """
    base: Path = current_app.config["UPLOAD_FOLDER"]
    path = base / model_id / "meta.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def delete_model(model_id: str) -> bool:
    """
    Permanently remove all files for a model.

    Returns True on success, False if the directory didn't exist.
    """
    base: Path = current_app.config["UPLOAD_FOLDER"]
    path = base / model_id
    if path.exists() and path.is_dir():
        shutil.rmtree(path)
        return True
    return False


def model_exists(model_id: str) -> bool:
    """Quick check — does a meta.json exist for this model?"""
    base: Path = current_app.config["UPLOAD_FOLDER"]
    return (base / model_id / "meta.json").exists()
