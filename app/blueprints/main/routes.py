"""
Main blueprint — gallery index page + health check.
"""

from flask import Blueprint, current_app, jsonify, render_template

from app.services import gallery_service

bp = Blueprint("main", __name__)


@bp.route("/")
def index():
    """Gallery page — lists all uploaded models."""
    models = gallery_service.list_models(current_app.config["UPLOAD_FOLDER"])
    max_upload_mb = current_app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)
    return render_template(
        "main/gallery.html",
        models=models,
        max_upload_mb=max_upload_mb,
    )


@bp.route("/health")
def health():
    return jsonify(status="ok", service="modelspace")
