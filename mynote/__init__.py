from __future__ import annotations

import os
import secrets
from pathlib import Path

from flask import Flask

from .db import close_db, init_app_database
from .routes import api, pages


def _persistent_secret(instance_path: Path) -> str:
    secret_file = instance_path / ".secret_key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()
    value = secrets.token_hex(32)
    secret_file.write_text(value, encoding="utf-8")
    return value


def create_app(test_config: dict | None = None) -> Flask:
    project_root = Path(__file__).resolve().parent.parent
    configured_instance = (
        os.environ.get("MYNOTE_INSTANCE_PATH")
        if test_config is None
        else test_config.get("INSTANCE_PATH")
    )
    instance_path = Path(configured_instance) if configured_instance else project_root / "instance"
    instance_path.mkdir(parents=True, exist_ok=True)
    (instance_path / "uploads").mkdir(parents=True, exist_ok=True)

    app = Flask(
        __name__,
        instance_path=str(instance_path),
        instance_relative_config=False,
        template_folder=str(project_root / "templates"),
        static_folder=str(project_root / "static"),
    )
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("MYNOTE_SECRET_KEY") or _persistent_secret(instance_path),
        DATABASE=str(instance_path / "mynote.sqlite3"),
        UPLOAD_FOLDER=str(instance_path / "uploads"),
        MAX_CONTENT_LENGTH=64 * 1024 * 1024,
        MAX_IMAGE_SIZE=10 * 1024 * 1024,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        JSON_AS_ASCII=False,
    )
    if test_config:
        app.config.update(test_config)

    def asset_version(filename: str) -> str:
        asset_path = Path(app.static_folder) / filename
        try:
            return f"{asset_path.stat().st_mtime_ns:x}"
        except OSError:
            return "missing"

    app.jinja_env.globals["asset_version"] = asset_version

    app.teardown_appcontext(close_db)
    app.register_blueprint(pages)
    app.register_blueprint(api)

    with app.app_context():
        init_app_database()

    return app
