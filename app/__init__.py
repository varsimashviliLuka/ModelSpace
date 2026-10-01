"""
Application factory.

Usage:
    from app import create_app
    app = create_app()          # uses FLASK_ENV from environment
    app = create_app("testing") # explicit environment
"""

from __future__ import annotations

from flask import Flask

from .config import Config, get_config


def create_app(env: str | None = None) -> Flask:
    """
    Create and configure the Flask application.

    Args:
        env: Optional override for the configuration environment
             ('development', 'testing', 'production').
             If None, reads FLASK_ENV from the environment.

    Returns:
        A fully configured Flask application instance.
    """
    app = Flask(
        __name__,
        template_folder="templates",
        static_folder="static",
    )

    # ------------------------------------------------------------------ #
    # Load configuration
    # ------------------------------------------------------------------ #
    from .config import config_map

    if env is not None:
        cfg_class = config_map.get(env, get_config())
    else:
        cfg_class = get_config()

    app.config.from_object(cfg_class)
    cfg_class.init_app(app)

    # ------------------------------------------------------------------ #
    # Register blueprints
    # ------------------------------------------------------------------ #
    _register_blueprints(app)

    # ------------------------------------------------------------------ #
    # Register global error handlers
    # ------------------------------------------------------------------ #
    _register_error_handlers(app)

    return app


def _register_blueprints(app: Flask) -> None:
    from .blueprints.main.routes import bp as main_bp
    from .blueprints.upload.routes import bp as upload_bp
    from .blueprints.viewer.routes import bp as viewer_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(upload_bp, url_prefix="/upload")
    app.register_blueprint(viewer_bp, url_prefix="/view")


def _register_error_handlers(app: Flask) -> None:
    from flask import jsonify, render_template

    @app.errorhandler(404)
    def not_found(e):
        return render_template("errors/404.html"), 404

    @app.errorhandler(413)
    def too_large(e):
        return (
            jsonify(
                error="File too large",
                detail=(
                    f"Maximum upload size is "
                    f"{app.config['MAX_CONTENT_LENGTH'] // (1024*1024)} MB."
                ),
            ),
            413,
        )

    @app.errorhandler(500)
    def server_error(e):
        return render_template("errors/500.html"), 500
