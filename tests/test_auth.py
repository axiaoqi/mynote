from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from werkzeug.security import check_password_hash

from mynote.db import get_db
from tests.conftest import api_request, csrf, register


def cookie_expiry(response, cookie_name="session"):
    cookie_header = next(
        header for header in response.headers.getlist("Set-Cookie")
        if header.startswith(f"{cookie_name}=")
    )
    expires = next(
        part.split("=", 1)[1]
        for part in cookie_header.split("; ")
        if part.startswith("Expires=")
    )
    return parsedate_to_datetime(expires), cookie_header


def assert_cookie_lasts_about_30_days(response, cookie_name="session"):
    expires, cookie_header = cookie_expiry(response, cookie_name)
    remaining = expires - datetime.now(timezone.utc)
    assert timedelta(days=29, hours=23) < remaining <= timedelta(days=30, minutes=1)
    assert "HttpOnly" in cookie_header
    assert "SameSite=Lax" in cookie_header


def test_first_user_is_admin_and_password_is_hashed(app, client):
    response = register(client)
    assert response.status_code == 201
    assert_cookie_lasts_about_30_days(response, app.config["SESSION_COOKIE_NAME"])
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
    assert_cookie_lasts_about_30_days(good)


def test_session_status_upgrades_legacy_session_and_refreshes_cookie(app, client):
    assert register(client).status_code == 201

    with client.session_transaction() as legacy_session:
        legacy_session.permanent = False

    upgraded = client.get("/api/session")
    assert upgraded.get_json()["authenticated"] is True
    assert_cookie_lasts_about_30_days(upgraded, app.config["SESSION_COOKIE_NAME"])

    refreshed = client.get("/api/groups")
    assert refreshed.status_code == 200
    assert_cookie_lasts_about_30_days(refreshed, app.config["SESSION_COOKIE_NAME"])


def test_logout_deletes_persistent_session_cookie(client):
    assert register(client).status_code == 201

    logged_out = api_request(client, "POST", "/api/logout")
    assert logged_out.status_code == 200
    cookie_header = next(
        header for header in logged_out.headers.getlist("Set-Cookie")
        if header.startswith("session=")
    )
    assert "Expires=Thu, 01 Jan 1970 00:00:00 GMT" in cookie_header

    protected = client.get("/api/groups")
    assert protected.status_code == 401
    assert protected.get_json()["code"] == "login_required"


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
