from __future__ import annotations

from werkzeug.security import check_password_hash

from mynote.db import get_db
from tests.conftest import api_request, csrf, register


def test_first_user_is_admin_and_password_is_hashed(app, client):
    response = register(client)
    assert response.status_code == 201
    payload = response.get_json()
    assert payload["user"]["is_admin"] is True
    assert payload["user"]["display_name"] == "主人"

    with app.app_context():
        user = get_db().execute("SELECT * FROM users WHERE username = 'owner'").fetchone()
        assert user["password_hash"] != "password123"
        assert check_password_hash(user["password_hash"], "password123")


def test_mutations_require_csrf(client):
    client.get("/api/session")
    response = client.post(
        "/api/register",
        json={"username": "owner", "password": "password123", "display_name": "主人"},
    )
    assert response.status_code == 403
    assert response.get_json()["code"] == "csrf_failed"


def test_login_logout_and_password_change(client):
    assert register(client).status_code == 201
    changed = api_request(
        client,
        "PATCH",
        "/api/account",
        json={"current_password": "password123", "new_password": "newpassword456"},
    )
    assert changed.status_code == 200
    assert api_request(client, "POST", "/api/logout").status_code == 200

    bad = client.post(
        "/api/login",
        json={"username": "owner", "password": "password123"},
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert bad.status_code == 401
    good = client.post(
        "/api/login",
        json={"username": "owner", "password": "newpassword456"},
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert good.status_code == 200


def test_admin_can_close_registration_and_disable_member(app, client):
    assert register(client).status_code == 201
    second = app.test_client()
    assert register(second, "family", "familypass123", "家人").status_code == 201
    member_id = second.get("/api/session").get_json()["user"]["id"]

    closed = api_request(client, "PATCH", "/api/admin/registration", json={"open": False})
    assert closed.status_code == 200
    third = app.test_client()
    assert register(third, "visitor", "visitorpass123", "访客").status_code == 403

    disabled = api_request(client, "PATCH", f"/api/admin/users/{member_id}", json={"is_active": False})
    assert disabled.status_code == 200
    assert second.get("/api/session").get_json()["authenticated"] is False
