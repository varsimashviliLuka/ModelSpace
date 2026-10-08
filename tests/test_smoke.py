"""
Smoke + upload tests.

Run:
    pytest tests/test_smoke.py -v
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from app import create_app


@pytest.fixture()
def app():
    application = create_app("testing")
    application.config["TESTING"] = True
    yield application


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def _clean_uploads(app):
    """Wipe the testing upload folder before/after each test."""
    folder: Path = app.config["UPLOAD_FOLDER"]
    if folder.exists():
        for child in folder.iterdir():
            if child.is_dir():
                import shutil
                shutil.rmtree(child)
            else:
                child.unlink()
    folder.mkdir(parents=True, exist_ok=True)
    yield
    if folder.exists():
        import shutil
        shutil.rmtree(folder, ignore_errors=True)


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "ok"
    assert data["service"] == "modelspace"


def test_index_page(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"ModelSpace" in response.data
    assert b".glb" in response.data


def test_upload_get_redirects(client):
    response = client.get("/upload/")
    assert response.status_code in (301, 302)
    assert response.headers["Location"].endswith("/")


def test_viewer_missing_model_404(client):
    response = client.get("/view/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def test_404(client):
    response = client.get("/this/does/not/exist")
    assert response.status_code == 404


def test_config_upload_folder(app):
    assert app.config["UPLOAD_FOLDER"] is not None


def test_config_max_size(app):
    assert app.config["MAX_CONTENT_LENGTH"] > 0


def test_upload_rejects_unsupported(client):
    data = {
        "archive": (io.BytesIO(b"not a model"), "notes.txt"),
        "model_name": "bad",
    }
    response = client.post("/upload/", data=data, content_type="multipart/form-data")
    assert response.status_code == 422
    assert b"Unsupported file type" in response.data


def test_failed_rar_cleans_upload_folder(client, app):
    """Failed RAR extraction must not leave orphan folders under uploads/."""
    data = {
        "archive": (io.BytesIO(b"this is not a real rar"), "broken.rar"),
        "model_name": "BrokenRar",
    }
    response = client.post("/upload/", data=data, content_type="multipart/form-data")
    assert response.status_code == 422
    upload_folder: Path = app.config["UPLOAD_FOLDER"]
    leftovers = [p for p in upload_folder.iterdir() if p.is_dir()] if upload_folder.is_dir() else []
    assert leftovers == [], f"Expected no leftover upload dirs, found {[p.name for p in leftovers]}"


def test_upload_direct_glb(client, app):
    """A lone .glb should be accepted and land on the viewer."""
    glb_bytes = b"glTF" + b"\x00" * 20  # enough for probe to fail soft
    data = {
        "archive": (io.BytesIO(glb_bytes), "robot.glb"),
        "model_name": "Robot",
    }
    response = client.post(
        "/upload/",
        data=data,
        content_type="multipart/form-data",
        follow_redirects=False,
    )
    assert response.status_code in (301, 302)
    location = response.headers["Location"]
    assert "/view/" in location

    model_id = location.rstrip("/").split("/")[-1]
    meta_path = app.config["UPLOAD_FOLDER"] / model_id / "meta.json"
    assert meta_path.exists()
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["status"] == "ready"
    assert meta["upload_kind"] == "direct"
    assert meta["display_name"] == "Robot"
    assert meta["detection"]["format"] == "glb"
    assert (app.config["UPLOAD_FOLDER"] / model_id / "extracted" / "robot.glb").exists()


def test_upload_zip_with_glb(client, app):
    """A .zip containing a .glb should extract and become ready."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("models/thing.glb", b"glTF" + b"\x00" * 20)
    buf.seek(0)

    data = {"archive": (buf, "pack.zip")}
    response = client.post(
        "/upload/",
        data=data,
        content_type="multipart/form-data",
        follow_redirects=False,
    )
    assert response.status_code in (301, 302)
    location = response.headers["Location"]
    assert "/view/" in location

    model_id = location.rstrip("/").split("/")[-1]
    meta = json.loads(
        (app.config["UPLOAD_FOLDER"] / model_id / "meta.json").read_text(encoding="utf-8")
    )
    assert meta["status"] == "ready"
    assert meta["upload_kind"] == "archive"
    assert meta["detection"]["main_file"].endswith("thing.glb")


def test_upload_zip_with_ply_blocks(client, app):
    """A zip of several .ply blocks should be ready and list every block."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("terra/Block2/Block2.ply", b"ply")
        zf.writestr("terra/Block10/Block10.ply", b"ply")
        zf.writestr("terra/Block1/Block1.ply", b"ply")
    buf.seek(0)
    response = client.post(
        "/upload/",
        data={"archive": (buf, "terra.zip")},
        content_type="multipart/form-data",
        follow_redirects=False,
    )
    assert response.status_code in (301, 302)
    model_id = response.headers["Location"].rstrip("/").split("/")[-1]
    meta = json.loads(
        (app.config["UPLOAD_FOLDER"] / model_id / "meta.json").read_text(encoding="utf-8")
    )
    assert meta["status"] == "ready"
    assert meta["detection"]["format"] == "ply"
    assert meta["detection"]["loader"] == "PLYBlockLoader"
    names = [p.split("/")[-1] for p in meta["detection"]["ply_files"]]
    assert names == ["Block1.ply", "Block2.ply", "Block10.ply"]


def test_save_viewer_settings_persists(client, app):
    """PATCH viewer-settings should persist rotation, position, scale, exposure."""
    glb_bytes = b"glTF" + b"\x00" * 20
    data = {"archive": (io.BytesIO(glb_bytes), "orient.glb")}
    resp = client.post(
        "/upload/",
        data=data,
        content_type="multipart/form-data",
        follow_redirects=False,
    )
    model_id = resp.headers["Location"].rstrip("/").split("/")[-1]

    patch = client.patch(
        f"/upload/{model_id}/viewer-settings",
        json={
            "rotation": {"x": 90, "y": 180, "z": -90},
            "position": {"x": 1.5, "y": -0.25, "z": 2},
            "scale": 2.5,
            "exposure": 1.75,
        },
    )
    assert patch.status_code == 200
    body = patch.get_json()
    assert body["ok"] is True
    assert body["viewer_settings"]["rotation"] == {"x": 90.0, "y": 180.0, "z": 270.0}
    assert body["viewer_settings"]["position"]["x"] == 1.5
    assert body["viewer_settings"]["scale"] == 2.5
    assert body["viewer_settings"]["exposure"] == 1.75

    meta = json.loads(
        (app.config["UPLOAD_FOLDER"] / model_id / "meta.json").read_text(encoding="utf-8")
    )
    assert meta["viewer_settings"]["scale"] == 2.5
    assert meta["rotation"]["y"] == 180.0

    page = client.get(f"/view/{model_id}")
    assert page.status_code == 200
    assert b"viewer_settings" in page.data or b'"scale": 2.5' in page.data or b'"scale":2.5' in page.data
