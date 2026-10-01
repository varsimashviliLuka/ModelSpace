"""
Upload blueprint.

Routes:
    GET  /upload/                     → redirect to gallery
    POST /upload/                     → upload archive or single model, process, redirect to viewer
    GET  /upload/status/<id>          → JSON processing status
    POST /upload/<model_id>/thumbnail → save client-captured thumbnail
    PATCH /upload/<model_id>/name            → rename a model
    PATCH /upload/<model_id>/viewer-settings → save rotation/position/scale/exposure
    PATCH /upload/<model_id>/rotation        → legacy alias (rotation only)
    DELETE /upload/<model_id>                → delete model + all files
"""

from __future__ import annotations

import base64
import re
import time
from pathlib import Path

from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)

from app.services import archive_service, storage_service

bp = Blueprint("upload", __name__, template_folder="../../templates")

_SAFE_ID  = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
NAME_MAX  = 120


# ------------------------------------------------------------------ #
# Helpers
# ------------------------------------------------------------------ #

def _ext(filename: str) -> str:
    if "." not in filename:
        return ""
    return filename.rsplit(".", 1)[-1].lower()


def _is_archive(filename: str) -> bool:
    return _ext(filename) in current_app.config["ALLOWED_ARCHIVE_EXTENSIONS"]


def _is_direct_model(filename: str) -> bool:
    return _ext(filename) in current_app.config["ALLOWED_DIRECT_MODEL_EXTENSIONS"]


def _file_list_for_meta(files: list[Path], extract_dir: Path) -> list[dict]:
    result = []
    max_entries = current_app.config.get("MAX_META_FILES", 500)
    for f in files[:max_entries]:
        try:
            rel  = f.relative_to(extract_dir)
            size = f.stat().st_size if f.exists() else 0
        except (ValueError, OSError):
            continue
        result.append({"path": str(rel).replace("\\", "/"), "size": size})
    return result


def _validate_model_id(model_id: str) -> bool:
    return bool(_SAFE_ID.match(model_id))


def _sanitise_name(raw: str | None) -> str | None:
    """
    Clean and validate a user-supplied model name.
    Returns the trimmed name, or None if it's empty/too long.
    """
    if not raw:
        return None
    name = raw.strip()
    if not name:
        return None
    if len(name) > NAME_MAX:
        name = name[:NAME_MAX].strip()
    return name or None


def _upload_error(model_id: str | None, error: str, *, warnings=None, hint=None, status=422):
    """Render the upload error page (works with XHR via status + HTML body)."""
    return render_template(
        "upload/error.html",
        model_id=model_id,
        error=error,
        warnings=warnings or [],
        hint=hint,
    ), status


def _fail_and_cleanup(
    model_id: str | None,
    error: str,
    *,
    warnings=None,
    hint=None,
    status=422,
):
    """
    Remove any partial upload directory, then show the error page.
    Prevents orphaned folders under uploads/ for failed RAR/zip/detect paths.
    """
    if model_id:
        try:
            storage_service.delete_model(model_id)
        except Exception:
            current_app.logger.exception(
                "Failed to clean up upload folder for model_id=%s", model_id
            )
    return _upload_error(
        None, error, warnings=warnings, hint=hint, status=status
    )


# ------------------------------------------------------------------ #
# Routes
# ------------------------------------------------------------------ #

@bp.route("/", methods=["GET"])
def upload_index():
    return redirect(url_for("main.index"))


@bp.route("/", methods=["POST"])
def upload_file():
    if "archive" not in request.files:
        return _upload_error(None, "No file field in the request.")

    file = request.files["archive"]
    if not file.filename:
        return _upload_error(None, "No file selected.")

    is_archive = _is_archive(file.filename)
    is_direct  = _is_direct_model(file.filename)

    if not is_archive and not is_direct:
        return _upload_error(
            None,
            "Unsupported file type.",
            hint=(
                "Upload a single .glb / .gltf / .obj file, "
                "or a .zip / .rar archive containing the model (and textures)."
            ),
        )

    custom_name = _sanitise_name(request.form.get("model_name", ""))
    model_id    = storage_service.new_model_id()
    started_at  = time.time()

    try:
        raw_path = storage_service.save_raw_archive(model_id, file, file.filename)
    except Exception as exc:
        current_app.logger.exception("Failed to save uploaded file")
        return _fail_and_cleanup(
            model_id, f"Could not save uploaded file: {exc}", status=500
        )

    initial_meta: dict = {
        "model_id":          model_id,
        "original_filename": file.filename,
        "raw_archive":       str(raw_path.relative_to(current_app.config["UPLOAD_FOLDER"])).replace("\\", "/"),
        "upload_kind":       "archive" if is_archive else "direct",
        "status":            "extracting" if is_archive else "inspecting",
        "uploaded_at":       started_at,
    }
    if custom_name:
        initial_meta["display_name"] = custom_name

    storage_service.write_meta(model_id, initial_meta)

    warnings: list[str] = []

    try:
        if is_archive:
            extract_dir = storage_service.extracted_dir(model_id)
            result = archive_service.extract(raw_path, extract_dir)

            if not result.success:
                hint = None
                if _ext(file.filename) == "rar":
                    hint = (
                        "Re-compress the folder as a .zip (Windows: right-click → "
                        "Compress to ZIP / Send to Compressed folder) and upload that instead."
                    )
                return _fail_and_cleanup(
                    model_id,
                    result.error or "Extraction failed.",
                    warnings=result.warnings,
                    hint=hint,
                )

            file_entries = _file_list_for_meta(result.files, extract_dir)
            warnings = result.warnings
            storage_service.write_meta(model_id, {
                "status":              "inspecting",
                "file_count":          len(result.files),
                "files":               file_entries,
                "extraction_warnings": warnings,
                "extracted_at":        time.time(),
            })
        else:
            # Single model file → copy into extracted/ (same layout the viewer expects)
            extract_dir, file_entries = storage_service.place_direct_model(model_id, raw_path)
            storage_service.write_meta(model_id, {
                "status":       "inspecting",
                "file_count":   len(file_entries),
                "files":        file_entries,
                "extracted_at": time.time(),
            })

        from app.services import model_service, optimize_service

        max_edge = int(current_app.config.get("MAX_TEXTURE_EDGE", 2048) or 0)
        if max_edge > 0:
            storage_service.write_meta(model_id, {"status": "optimizing"})
            opt = optimize_service.downscale_textures(extract_dir, max_edge)
            storage_service.write_meta(model_id, {"texture_optimize": opt})

        detection = model_service.detect(extract_dir, file_entries)
        storage_service.write_meta(model_id, {
            "status":       "ready" if detection["main_file"] else "unsupported",
            "detection":    detection,
            "processed_at": time.time(),
        })

        if not detection["main_file"]:
            return _fail_and_cleanup(
                model_id,
                detection.get("error", "No supported 3D model file found."),
                warnings=warnings,
                hint=detection.get("hint"),
            )

        return redirect(url_for("viewer.view_model", model_id=model_id))

    except Exception as exc:
        current_app.logger.exception("Upload processing failed for %s", model_id)
        return _fail_and_cleanup(
            model_id,
            f"Processing failed: {exc}",
            status=500,
        )


@bp.route("/status/<model_id>", methods=["GET"])
def upload_status(model_id: str):
    meta = storage_service.read_meta(model_id)
    if meta is None:
        return jsonify(error="Model not found"), 404
    return jsonify({k: v for k, v in meta.items() if k != "files"})


@bp.route("/<model_id>/thumbnail", methods=["POST"])
def save_thumbnail(model_id: str):
    """POST /upload/<model_id>/thumbnail — save client-captured JPEG."""
    if not _validate_model_id(model_id):
        return jsonify(error="Invalid model id"), 400
    if not storage_service.model_exists(model_id):
        return jsonify(error="Model not found"), 404

    payload = request.get_json(silent=True)
    if not payload or "data" not in payload:
        return jsonify(error="Missing data field"), 400

    data_url: str = payload["data"]
    if not data_url.startswith("data:image/"):
        return jsonify(error="Invalid image data"), 400

    try:
        _, b64 = data_url.split(",", 1)
        img_bytes = base64.b64decode(b64)
    except Exception:
        return jsonify(error="Could not decode image"), 400

    if len(img_bytes) > 4 * 1024 * 1024:
        return jsonify(error="Thumbnail too large (>4 MB)"), 413

    thumb_path = storage_service.model_dir(model_id) / "thumbnail.jpg"
    try:
        thumb_path.write_bytes(img_bytes)
    except OSError as exc:
        return jsonify(error=f"Could not save thumbnail: {exc}"), 500

    storage_service.write_meta(model_id, {"has_thumbnail": True})
    return jsonify(ok=True)


@bp.route("/<model_id>/name", methods=["PATCH"])
def rename_model(model_id: str):
    """
    PATCH /upload/<model_id>/name

    Body (JSON): { "name": "New display name" }

    Updates the model's display_name in meta.json.
    """
    if not _validate_model_id(model_id):
        return jsonify(error="Invalid model id"), 400
    if not storage_service.model_exists(model_id):
        return jsonify(error="Model not found"), 404

    payload = request.get_json(silent=True)
    if not payload:
        return jsonify(error="Expected JSON body"), 400

    new_name = _sanitise_name(payload.get("name", ""))
    if not new_name:
        return jsonify(error="Name cannot be empty (or exceeds 120 characters after trimming)"), 422

    storage_service.write_meta(model_id, {"display_name": new_name})
    return jsonify(ok=True, name=new_name)


@bp.route("/<model_id>/viewer-settings", methods=["PATCH"])
def save_viewer_settings(model_id: str):
    """
    PATCH /upload/<model_id>/viewer-settings

    Body (JSON), all fields optional:
      {
        "rotation": { "x": 0, "y": 90, "z": 0 },   # degrees 0–360
        "position": { "x": 0, "y": 0, "z": 0 },    # metres offset
        "scale": 1.0,
        "exposure": 1.0
      }
    """
    if not _validate_model_id(model_id):
        return jsonify(error="Invalid model id"), 400
    if not storage_service.model_exists(model_id):
        return jsonify(error="Model not found"), 404

    payload = request.get_json(silent=True)
    if not payload or not isinstance(payload, dict):
        return jsonify(error="Expected JSON body"), 400

    meta = storage_service.read_meta(model_id) or {}
    current = dict(meta.get("viewer_settings") or {})
    # Migrate legacy top-level rotation if present
    if "rotation" not in current and isinstance(meta.get("rotation"), dict):
        current["rotation"] = meta["rotation"]

    try:
        if "rotation" in payload:
            current["rotation"] = _parse_vec3(
                payload["rotation"], mod360=True, label="rotation"
            )
        if "position" in payload:
            current["position"] = _parse_vec3(
                payload["position"], lo=-50.0, hi=50.0, label="position"
            )
        if "scale" in payload:
            scale = float(payload["scale"])
            if not (0.01 <= scale <= 50):
                return jsonify(error="scale must be between 0.01 and 50"), 422
            current["scale"] = round(scale, 6)
        if "exposure" in payload:
            exposure = float(payload["exposure"])
            if not (0.0 <= exposure <= 4.0):
                return jsonify(error="exposure must be between 0 and 4"), 422
            current["exposure"] = round(exposure, 4)
    except (TypeError, ValueError) as exc:
        return jsonify(error=str(exc)), 422

    # Keep legacy rotation key in sync for older clients
    write = {"viewer_settings": current}
    if "rotation" in current:
        write["rotation"] = current["rotation"]
    storage_service.write_meta(model_id, write)
    return jsonify(ok=True, viewer_settings=current)


@bp.route("/<model_id>/rotation", methods=["PATCH"])
def save_rotation(model_id: str):
    """Legacy alias — stores rotation inside viewer_settings."""
    if not _validate_model_id(model_id):
        return jsonify(error="Invalid model id"), 400
    if not storage_service.model_exists(model_id):
        return jsonify(error="Model not found"), 404

    payload = request.get_json(silent=True)
    if not payload or not isinstance(payload, dict):
        return jsonify(error="Expected JSON body with x/y/z degrees"), 400

    rot = payload.get("rotation") if isinstance(payload.get("rotation"), dict) else payload
    try:
        rotation = _parse_vec3(rot, mod360=True, label="rotation")
    except (TypeError, ValueError) as exc:
        return jsonify(error=str(exc)), 422

    meta = storage_service.read_meta(model_id) or {}
    settings = dict(meta.get("viewer_settings") or {})
    settings["rotation"] = rotation
    storage_service.write_meta(model_id, {
        "viewer_settings": settings,
        "rotation": rotation,
    })
    return jsonify(ok=True, rotation=rotation)


def _parse_vec3(
    data,
    *,
    lo: float | None = None,
    hi: float | None = None,
    mod360: bool = False,
    label: str = "vector",
) -> dict:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be an object with x/y/z")
    out = {}
    for key in ("x", "y", "z"):
        try:
            val = float(data.get(key, 0))
        except (TypeError, ValueError):
            raise ValueError(f"Invalid {label}.{key}") from None
        if mod360:
            val = val % 360.0
            if val < 0:
                val += 360.0
        if lo is not None and val < lo:
            raise ValueError(f"{label}.{key} must be ≥ {lo}")
        if hi is not None and val > hi:
            raise ValueError(f"{label}.{key} must be ≤ {hi}")
        out[key] = round(val, 4)
    return out


@bp.route("/<model_id>", methods=["DELETE"])
def delete_model(model_id: str):
    """DELETE /upload/<model_id> — remove all model files safely."""
    if not _validate_model_id(model_id):
        return jsonify(error="Invalid model id"), 400

    upload_folder: Path = current_app.config["UPLOAD_FOLDER"]
    model_path = (upload_folder / model_id).resolve()

    try:
        model_path.relative_to(upload_folder.resolve())
    except ValueError:
        return jsonify(error="Path escape detected"), 403

    if not model_path.is_dir():
        return jsonify(error="Model not found"), 404

    deleted = storage_service.delete_model(model_id)
    if not deleted:
        return jsonify(error="Delete failed"), 404

    return jsonify(ok=True, model_id=model_id)
