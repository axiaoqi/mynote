from __future__ import annotations

import pytest

from mynote import create_app


@pytest.fixture()
def app(tmp_path):
    application = create_app(
        {
            "TESTING": True,
            "INSTANCE_PATH": str(tmp_path / "instance"),
            "SECRET_KEY": "test-secret-key",
            "MAX_IMAGE_SIZE": 1024 * 1024,
        }
    )
    yield application


@pytest.fixture()
def client(app):
    return app.test_client()


def csrf(client) -> str:
    return client.get("/api/session").get_json()["csrf_token"]


def register(client, username="owner", password="password123", display_name="主人"):
    token = csrf(client)
    return client.post(
        "/api/register",
        json={"username": username, "password": password, "display_name": display_name},
        headers={"X-CSRF-Token": token},
    )


def api_request(client, method: str, path: str, **kwargs):
    token = client.get("/api/session").get_json()["csrf_token"]
    headers = kwargs.pop("headers", {})
    headers["X-CSRF-Token"] = token
    return client.open(path, method=method, headers=headers, **kwargs)
