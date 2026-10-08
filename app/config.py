"""
Configuration classes for the ModelSpace application.
Uses a base Config with Development and Production subclasses.
Values are pulled from environment variables / .env file.
"""

import os
from pathlib import Path

# Resolve the project root regardless of where Python is invoked from.
BASE_DIR = Path(__file__).resolve().parent.parent


class Config:
    """Base configuration — shared by all environments."""

    # ------------------------------------------------------------------ #
    # Core Flask
    # ------------------------------------------------------------------ #
    SECRET_KEY: str = os.getenv("SECRET_KEY", "dev-secret-please-change")
    DEBUG: bool = False
    TESTING: bool = False

    # ------------------------------------------------------------------ #
    # Upload / storage
    # ------------------------------------------------------------------ #
    UPLOAD_FOLDER: Path = BASE_DIR / os.getenv("UPLOAD_FOLDER", "uploads")
    # Maximum archive size accepted (bytes).  Default 200 MB.
    MAX_CONTENT_LENGTH: int = (
        int(os.getenv("MAX_CONTENT_LENGTH_MB", 200)) * 1024 * 1024
    )
    # Archive formats we will attempt to extract.
    ALLOWED_ARCHIVE_EXTENSIONS: frozenset = frozenset({"zip", "rar"})
    # Single (non-archived) model files accepted for direct upload.
    # Prefer .glb for textures/animations; .gltf/.obj with external assets
    # still need a .zip/.rar package.
    ALLOWED_DIRECT_MODEL_EXTENSIONS: frozenset = frozenset(
        {"glb", "gltf", "obj", "ply"}
    )
    # 3D / asset formats we recognise inside an archive.
    SUPPORTED_MODEL_EXTENSIONS: frozenset = frozenset(
        {"glb", "gltf", "obj", "ply", "mtl", "fbx", "blend"}
    )
    SUPPORTED_TEXTURE_EXTENSIONS: frozenset = frozenset(
        {"png", "jpg", "jpeg", "webp", "bmp", "tga", "hdr", "exr"}
    )
    # Cap texture edge length after extract / in the browser (VRAM saver).
    # 0 disables server-side resizing. Client still clamps as a safety net.
    MAX_TEXTURE_EDGE: int = int(os.getenv("MAX_TEXTURE_EDGE", "2048"))

    # ------------------------------------------------------------------ #
    # SSL (used by run.py in dev)
    # ------------------------------------------------------------------ #
    SSL_CERT: str | None = os.getenv("SSL_CERT", None)
    SSL_KEY: str | None = os.getenv("SSL_KEY", None)

    # ------------------------------------------------------------------ #
    # VR / WebXR settings  (bridged to frontend via template injection)
    # Quest 3 face button indices: X=4, Y=5 (left), A=4, B=5 (right)
    # Binding format: "controllerIndex:buttonIndex"
    # ------------------------------------------------------------------ #
    VR_MOVE_SPEED: float    = float(os.getenv("VR_MOVE_SPEED",    "0.03"))
    VR_SNAP_ANGLE: float    = float(os.getenv("VR_SNAP_ANGLE",    "45"))    # degrees
    VR_HEIGHT_STEP: float   = float(os.getenv("VR_HEIGHT_STEP",   "0.1"))
    VR_HEIGHT_MIN: float    = float(os.getenv("VR_HEIGHT_MIN",    "-2.0"))
    VR_HEIGHT_MAX: float    = float(os.getenv("VR_HEIGHT_MAX",    "2.0"))
    VR_BTN_MENU_TOGGLE: str = os.getenv("VR_BTN_MENU_TOGGLE",  "0:4")      # left X
    VR_BTN_ANIM_TOGGLE: str = os.getenv("VR_BTN_ANIM_TOGGLE",  "0:5")      # left Y
    VR_BTN_HEIGHT_DOWN: str = os.getenv("VR_BTN_HEIGHT_DOWN",  "1:4")      # right A
    VR_BTN_HEIGHT_UP: str   = os.getenv("VR_BTN_HEIGHT_UP",    "1:5")      # right B
    # Zoom / turn additions
    VR_ZOOM_SPEED: float    = float(os.getenv("VR_ZOOM_SPEED",    "0.05"))  # metres per frame at full deflection
    VR_SMOOTH_TURN: bool    = os.getenv("VR_SMOOTH_TURN", "0") == "1"      # 1 = smooth, 0 = snap
    VR_TURN_SPEED: float    = float(os.getenv("VR_TURN_SPEED",    "1.5"))  # rad/s for smooth turn
    VR_DEADZONE: float      = float(os.getenv("VR_DEADZONE",      "0.12")) # thumbstick deadzone
    VR_ZOOM_MIN: float      = float(os.getenv("VR_ZOOM_MIN",      "0.3"))  # min distance from model
    VR_ZOOM_MAX: float      = float(os.getenv("VR_ZOOM_MAX",      "15.0")) # max distance from model

    # ------------------------------------------------------------------ #
    # Misc
    # ------------------------------------------------------------------ #
    # How many extracted-file entries to store in meta.json at most.
    MAX_META_FILES: int = 500

    @classmethod
    def init_app(cls, app) -> None:
        """Hook for environment-specific initialisation."""
        # Ensure the uploads folder exists at startup.
        cls.UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)


class DevelopmentConfig(Config):
    DEBUG: bool = True


class TestingConfig(Config):
    TESTING: bool = True
    # Use a temp directory for uploads during tests.
    UPLOAD_FOLDER: Path = BASE_DIR / "tests" / "tmp_uploads"


class ProductionConfig(Config):
    DEBUG: bool = False

    @classmethod
    def init_app(cls, app) -> None:
        super().init_app(app)
        # In production, secret key must be set explicitly.
        assert app.config["SECRET_KEY"] != "dev-secret-please-change", (
            "SECRET_KEY must be overridden in production!"
        )


# ------------------------------------------------------------------ #
# Registry — maps FLASK_ENV value to config class
# ------------------------------------------------------------------ #
config_map: dict[str, type[Config]] = {
    "development": DevelopmentConfig,
    "testing": TestingConfig,
    "production": ProductionConfig,
}


def get_config() -> type[Config]:
    env = os.getenv("FLASK_ENV", "development").lower()
    return config_map.get(env, DevelopmentConfig)
