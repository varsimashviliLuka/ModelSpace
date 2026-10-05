"""
Viewer blueprint.

Routes:
    GET /view/<model_id>               → Three.js viewer HTML page
    GET /view/<model_id>/asset/<path>  → serve extracted asset
    GET /view/<model_id>/meta          → JSON model metadata
    GET /view/<model_id>/thumbnail     → serve thumbnail image
"""

from __future__ import annotations

import math
from pathlib import Path

from flask import (
    Blueprint,
    abort,
    current_app,
    jsonify,
    render_template,
    send_file,
)

from app.services import storage_service

bp = Blueprint("viewer", __name__, template_folder="../../templates")


def _vr_config_from_app() -> dict:
    """Build a VR config dict from Flask app config to inject into the template."""
    cfg = current_app.config

    def _parse_binding(s: str) -> dict:
        """Parse '0:4' → {ctrl: 0, btn: 4}."""
        try:
            parts = str(s).split(":")
            return {"ctrl": int(parts[0]), "btn": int(parts[1])}
        except (IndexError, ValueError):
            return {"ctrl": 0, "btn": 0}

    return {
        "moveSpeed":      cfg.get("VR_MOVE_SPEED",    0.03),
        "snapAngle":      math.radians(cfg.get("VR_SNAP_ANGLE", 45)),
        "heightStep":     cfg.get("VR_HEIGHT_STEP",   0.1),
        "heightMin":      cfg.get("VR_HEIGHT_MIN",    -2.0),
        "heightMax":      cfg.get("VR_HEIGHT_MAX",    2.0),
        "menuToggle":     _parse_binding(cfg.get("VR_BTN_MENU_TOGGLE",  "0:4")),
        "animToggle":     _parse_binding(cfg.get("VR_BTN_ANIM_TOGGLE",  "0:5")),
        "heightDown":     _parse_binding(cfg.get("VR_BTN_HEIGHT_DOWN",  "1:4")),
        "heightUp":       _parse_binding(cfg.get("VR_BTN_HEIGHT_UP",    "1:5")),
        "zoomSpeed":      cfg.get("VR_ZOOM_SPEED",    0.05),
        "smoothTurn":     cfg.get("VR_SMOOTH_TURN",   False),
        "turnSpeed":      cfg.get("VR_TURN_SPEED",    1.5),
        "deadzone":       cfg.get("VR_DEADZONE",      0.12),
        "zoomMin":        cfg.get("VR_ZOOM_MIN",      0.3),
        "zoomMax":        cfg.get("VR_ZOOM_MAX",      15.0),
        "maxTextureEdge": cfg.get("MAX_TEXTURE_EDGE", 2048),
    }


@bp.route("/<model_id>")
def view_model(model_id: str):
    meta = storage_service.read_meta(model_id)
    if meta is None:
        abort(404)

    status = meta.get("status", "unknown")
    if status == "error":
        return render_template(
            "upload/error.html",
            model_id=model_id,
            error=meta.get("error", "Unknown error"),
            warnings=[], hint=None,
        ), 422

    if status != "ready":
        return render_template("viewer/processing.html", model_id=model_id, status=status)

    detection = meta.get("detection", {})
    has_thumb  = (current_app.config["UPLOAD_FOLDER"] / model_id / "thumbnail.jpg").exists()

    # Resolved display name: custom > derived from filename
    from app.services.gallery_service import _display_name as _derive_name
    original_filename = meta.get("original_filename", "model")
    display_name = meta.get("display_name") or _derive_name(original_filename)

    vs = meta.get("viewer_settings") or {}
    saved_rot = vs.get("rotation") or meta.get("rotation") or {}
    saved_pos = vs.get("position") or {}
    viewer_settings = {
        "rotation": {
            "x": float(saved_rot.get("x", 0) or 0),
            "y": float(saved_rot.get("y", 0) or 0),
            "z": float(saved_rot.get("z", 0) or 0),
        },
        "position": {
            "x": float(saved_pos.get("x", 0) or 0),
            "y": float(saved_pos.get("y", 0) or 0),
            "z": float(saved_pos.get("z", 0) or 0),
        },
        "scale": (
            float(vs["scale"])
            if vs.get("scale") is not None
            else None
        ),
        "scale_relative": bool(vs.get("scale_relative", False)),
        "exposure": float(vs.get("exposure", 1.0) or 1.0),
        "graphics_quality": (
            vs.get("graphics_quality")
            if vs.get("graphics_quality") in ("low", "medium", "high")
            else None
        ),
    }

    return render_template(
        "viewer/view.html",
        model_id=model_id,
        display_name=display_name,
        original_filename=original_filename,
        main_file=detection.get("main_file"),
        loader=detection.get("loader"),
        fmt=detection.get("format"),
        has_animation=detection.get("has_animation", False),
        mtl_file=detection.get("mtl_file"),
        resource_base=detection.get("resource_base"),
        textures=detection.get("textures", []),
        all_models=detection.get("all_models", []),
        has_thumbnail=has_thumb,
        viewer_settings=viewer_settings,
        vr_config=_vr_config_from_app(),
    )


@bp.route("/<model_id>/asset/<path:asset_path>")
def serve_asset(model_id: str, asset_path: str):
    upload_folder: Path = current_app.config["UPLOAD_FOLDER"]
    extract_dir = upload_folder / model_id / "extracted"

    if not extract_dir.is_dir():
        abort(404)

    target = (extract_dir / asset_path).resolve()
    try:
        target.relative_to(extract_dir.resolve())
    except ValueError:
        abort(403)

    if not target.is_file():
        abort(404)

    return send_file(target, mimetype=_mime_for(target.suffix.lower()))


@bp.route("/<model_id>/thumbnail")
def serve_thumbnail(model_id: str):
    """Serve uploads/<model_id>/thumbnail.jpg (or 404 if not generated yet)."""
    upload_folder: Path = current_app.config["UPLOAD_FOLDER"]
    thumb = (upload_folder / model_id / "thumbnail.jpg").resolve()
    try:
        thumb.relative_to(upload_folder.resolve())
    except ValueError:
        abort(403)
    if not thumb.is_file():
        abort(404)
    return send_file(thumb, mimetype="image/jpeg")


@bp.route("/<model_id>/meta")
def model_meta(model_id: str):
    meta = storage_service.read_meta(model_id)
    if meta is None:
        return jsonify(error="Not found"), 404
    return jsonify({k: v for k, v in meta.items() if k != "files"})


# ------------------------------------------------------------------ #
# MIME helper
# ------------------------------------------------------------------ #

_MIME_MAP: dict[str, str] = {
    ".glb":   "model/gltf-binary",
    ".gltf":  "model/gltf+json",
    ".obj":   "text/plain",
    ".mtl":   "text/plain",
    ".bin":   "application/octet-stream",
    ".png":   "image/png",
    ".jpg":   "image/jpeg",
    ".jpeg":  "image/jpeg",
    ".webp":  "image/webp",
    ".hdr":   "image/vnd.radiance",
    ".ktx":   "image/ktx",
    ".ktx2":  "image/ktx2",
    ".basis": "application/octet-stream",
}

def _mime_for(suffix: str) -> str:
    return _MIME_MAP.get(suffix, "application/octet-stream")
