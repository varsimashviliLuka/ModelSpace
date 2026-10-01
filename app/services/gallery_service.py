"""
gallery_service.py

Scans the upload folder and returns a list of all ready models.
No external DB needed — meta.json files are the source of truth.

Public API:
    list_models(upload_folder)  -> list[dict]
    model_summary(upload_folder, model_id) -> dict | None
"""

from __future__ import annotations

import json
from pathlib import Path


def list_models(upload_folder: Path) -> list[dict]:
    """
    Walk uploads/ and return a summary list of all 'ready' models,
    sorted newest-first.

    Each entry:
        model_id        str
        name            str   (original filename without extension)
        original_filename str
        format          str | None
        has_animation   bool
        has_thumbnail   bool
        uploaded_at     float (unix timestamp, 0 if missing)
    """
    models: list[dict] = []

    if not upload_folder.is_dir():
        return models

    for path in upload_folder.iterdir():
        if not path.is_dir():
            continue
        meta_path = path / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        if meta.get("status") != "ready":
            continue

        detection = meta.get("detection", {})
        # display_name is the user-set name; fall back to derived name from filename
        derived = _display_name(meta.get("original_filename", ""))
        models.append({
            "model_id":          meta.get("model_id", path.name),
            "name":              meta.get("display_name") or derived,
            "original_filename": meta.get("original_filename", ""),
            "format":            detection.get("format"),
            "has_animation":     detection.get("has_animation", False),
            "has_thumbnail":     (path / "thumbnail.jpg").exists(),
            "uploaded_at":       meta.get("uploaded_at", 0),
        })

    return sorted(models, key=lambda m: m["uploaded_at"], reverse=True)


def model_summary(upload_folder: Path, model_id: str) -> dict | None:
    """Return summary for a single model_id, or None if not found/ready."""
    results = list_models(upload_folder)
    for m in results:
        if m["model_id"] == model_id:
            return m
    return None


# ------------------------------------------------------------------ #
# Helpers
# ------------------------------------------------------------------ #

def _display_name(filename: str) -> str:
    """Turn 'my_cool_robot.zip' → 'my_cool_robot'."""
    if not filename:
        return "Untitled"
    stem = Path(filename).stem          # strip last extension
    # Also strip the archive extension if double-suffixed: model.glb.zip → model.glb
    stem = Path(stem).stem if Path(stem).suffix in (".glb", ".gltf", ".obj") else stem
    return stem.replace("_", " ").replace("-", " ").strip() or filename
