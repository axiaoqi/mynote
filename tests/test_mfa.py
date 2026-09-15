from __future__ import annotations

import io
import sqlite3
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pyotp
import pytest

from mynote import create_app
from mynote.db import get_db, init_app_database
from mynote.security import digest
from tests.conftest import api_request, csrf, register


@pytest.fixture
def tick(monkeypatch):
    clock = [1800000000]
    monkeypatch.setattr("mynote.security.now", lambda: clock[0])
    monkeypatch.setattr("mynote.mfa.now", lambda: clock[0])
    return clock


def post(client, path, **data):
    return api_request(client, "POST", path, json=data)


def login(client):
    return post(client, "/api/login", username="owner", password="password123")


def bind(client, tick):
    setup = post(client, "/api/mfa/setup", current_password="password123")
    assert setup.status_code == 200, setup.get_json()
    secret = setup.get_json()["secret"]
    assert setup.get_json()["qr_code"].startswith("data:image/svg+xml;base64,")
    enabled = post(client, "/api/mfa/enable", code=pyotp.TOTP(secret).at(tick[0]))
    assert enabled.status_code == 200, enabled.get_json()
    tick[0] += 30
    return secret, enabled.get_json()["recovery_codes"]


def test_binding_pending_login_replay_and_cancel(app, client, tick):
    register(client)
    other = app.test_client()
    assert login(other).status_code == 200
    secret, codes = bind(client, tick)
    assert len(codes) == len(set(codes)) == 10
    assert client.get("/api/mfa").get_json()["enabled"]
    assert other.get("/api/groups").status_code == 401
    post(client, "/api/logout")
    response = login(client)
    assert response.get_json()["mfa_required"]
    cookie = client.get_cookie("session").value
    with client.session_transaction() as state:
        assert "user_id" not in state
        assert "mfa_challenge" in state
        assert secret not in str(dict(state))
    assert client.get("/api/session").get_json()["mfa_required"]
    for path in ("/api/groups", "/api/notes", "/api/export/json", "/api/admin/users", "/api/mfa"):
        assert client.get(path).status_code == 401
    assert post(client, "/api/mfa/login", code="wrong").status_code == 400
    code = pyotp.TOTP(secret).at(tick[0])
    assert post(client, "/api/mfa/login", code=code).status_code == 200
    assert client.get("/api/groups").status_code == 200
    replay = app.test_client()
    replay.set_cookie("session", cookie)
    assert post(replay, "/api/mfa/login", code=codes[0]).status_code == 401
    assert login(other).get_json()["mfa_required"]
    assert post(other, "/api/mfa/login", code=code).status_code == 400
    assert post(other, "/api/mfa/cancel").status_code == 200
    assert post(other, "/api/mfa/login", recovery_code=codes[0]).status_code == 401


def test_recovery_single_use_regeneration_and_disable(app, client, tick):
    register(client)
    secret, codes = bind(client, tick)
    post(client, "/api/logout")
    login(client)
    assert post(client, "/api/mfa/login", recovery_code=codes[0].lower()).status_code == 200
    assert client.get("/api/mfa").get_json()["recovery_codes_remaining"] == 9
    other = app.test_client()
    login(other)
    assert post(other, "/api/mfa/login", recovery_code=codes[0]).status_code == 400
    regenerated = post(client, "/api/mfa/recovery-codes", current_password="password123", code=pyotp.TOTP(secret).at(tick[0]))
    assert regenerated.status_code == 200
    fresh = regenerated.get_json()["recovery_codes"]
    # A security change invalidates already-issued password-only challenges too.
    assert post(other, "/api/mfa/login", recovery_code=codes[1]).status_code == 401
    login(other)
    assert post(other, "/api/mfa/login", recovery_code=codes[1]).status_code == 400
    assert post(other, "/api/mfa/login", recovery_code=fresh[0]).status_code == 200
    assert post(client, "/api/mfa/disable", current_password="wrong", recovery_code=fresh[1]).status_code == 400
    assert post(client, "/api/mfa/disable", current_password="password123", recovery_code=fresh[1]).status_code == 200
    assert not client.get("/api/mfa").get_json()["enabled"]
    assert other.get("/api/groups").status_code == 401
    assert login(other).get_json().get("mfa_required") is None


def test_password_change_requires_factor_and_revokes_sessions(app, client, tick):
    register(client)
    secret, codes = bind(client, tick)
    other = app.test_client()
    login(other)
    post(other, "/api/mfa/login", recovery_code=codes[0])
    body = dict(current_password="password123", new_password="new-password456")
    failed = api_request(client, "PATCH", "/api/account", json={**body, "display_name": "must-not-save"})
    assert failed.status_code == 400
    assert client.get("/api/session").get_json()["user"]["display_name"] == "主人"
    result = api_request(client, "PATCH", "/api/account", json={**body, "code": pyotp.TOTP(secret).at(tick[0])})
    assert result.status_code == 200
    assert client.get("/api/groups").status_code == 200
    assert other.get("/api/groups").status_code == 401
    assert post(other, "/api/login", username="owner", password="new-password456").get_json()["mfa_required"]


def test_limits_survive_new_challenges_and_apply_to_account(app, client, tick):
    register(client)
    _, codes = bind(client, tick)
    post(client, "/api/logout")
    login(client)
    for _ in range(4):
        assert post(client, "/api/mfa/login", code="wrong").status_code == 400
        assert login(client).status_code == 200
    assert post(client, "/api/mfa/login", code="wrong").status_code == 429
    other = app.test_client()
    response = api_request(other, "POST", "/api/login", json={"username": "owner", "password": "password123"}, environ_overrides={"REMOTE_ADDR": "192.0.2.42"})
    assert response.status_code == 429
    tick[0] += 901
    assert login(client).status_code == 200
    assert post(client, "/api/mfa/login", recovery_code=codes[0]).status_code == 200


def test_expiry_setup_replacement_csrf_and_no_cache(client, tick):
    register(client)
    first = post(client, "/api/mfa/setup", current_password="password123").get_json()["secret"]
    second = post(client, "/api/mfa/setup", current_password="password123").get_json()["secret"]
    assert first != second
    assert post(client, "/api/mfa/enable", code=pyotp.TOTP(first).at(tick[0])).status_code == 400
    tick[0] += 601
    assert post(client, "/api/mfa/enable", code=pyotp.TOTP(second).at(tick[0])).get_json()["code"] == "setup_expired"
    _, codes = bind(client, tick)
    post(client, "/api/logout")
    login(client)
    assert client.post("/api/mfa/login", json={"recovery_code": codes[0]}).status_code == 403
    tick[0] += 301
    assert post(client, "/api/mfa/login", recovery_code=codes[0]).status_code == 401
    assert not client.get("/api/session").get_json()["authenticated"]
    assert client.get("/api/session").headers["Cache-Control"] == "no-store"


def test_encryption_exports_missing_key_and_local_reset(app, client, tick):
    register(client)
    secret, codes = bind(client, tick)
    with app.app_context():
        db = get_db()
        encrypted = db.execute("SELECT totp_secret FROM users").fetchone()[0]
        assert secret not in encrypted
        assert db.execute("SELECT code_hash FROM recovery_codes").fetchone()[0] not in codes
    raw = client.get("/api/export/backup").data
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        content = b"".join(archive.read(name) for name in archive.namelist())
    for value in (secret, encrypted, codes[0], digest(codes[0].replace("-", ""))):
        assert value.encode() not in content
    from pathlib import Path
    key_file = Path(app.instance_path) / ".mfa_key"
    original_key = key_file.read_bytes()
    key_file.unlink()
    post(client, "/api/logout")
    login(client)
    assert post(client, "/api/mfa/login", code=pyotp.TOTP(secret).at(tick[0])).status_code == 503
    assert not key_file.exists()
    # Recovery codes remain usable even when encryption key restoration is needed.
    assert post(client, "/api/mfa/login", recovery_code=codes[0]).status_code == 200
    reset = app.test_cli_runner().invoke(args=["reset-mfa", "owner", "--yes"])
    assert reset.exit_code == 0, reset.output
    assert client.get("/api/groups").status_code == 401
    assert not login(client).get_json().get("mfa_required")
    key_file.write_bytes(original_key)


def test_recovery_consumed_atomically(app, client, tick):
    register(client)
    _, codes = bind(client, tick)
    clients = [app.test_client(), app.test_client()]
    for item in clients:
        login(item)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda item: post(item, "/api/mfa/login", recovery_code=codes[0]).status_code, clients))
    assert sorted(results) == [200, 400]


def test_totp_consumed_atomically_and_legacy_cookie_revoked(app, client, tick):
    register(client)
    with client.session_transaction() as legacy:
        legacy.pop("auth_version")
    old_cookie = client.get_cookie("session").value
    secret, _ = bind(client, tick)
    legacy_client = app.test_client()
    legacy_client.set_cookie("session", old_cookie)
    assert not legacy_client.get("/api/session").get_json()["authenticated"]
    clients = [app.test_client(), app.test_client()]
    for item in clients:
        login(item)
    code = pyotp.TOTP(secret).at(tick[0])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda item: post(item, "/api/mfa/login", code=code).status_code, clients))
    assert sorted(results) == [200, 400]


def test_setup_password_limits_and_disabled_member_sessions(app, client, tick):
    register(client)
    for _ in range(4):
        assert post(client, "/api/mfa/setup", current_password="bad").status_code == 400
    assert post(client, "/api/mfa/setup", current_password="bad").status_code == 429
    tick[0] += 901
    member = app.test_client()
    result = register(member, "member", "member-password")
    user_id = result.get_json()["user"]["id"]
    old_cookie = member.get_cookie("session").value
    assert api_request(client, "PATCH", f"/api/admin/users/{user_id}", json={"is_active": False}).status_code == 200
    assert api_request(client, "PATCH", f"/api/admin/users/{user_id}", json={"is_active": True}).status_code == 200
    member.set_cookie("session", old_cookie)
    assert member.get("/api/groups").status_code == 401


def test_legacy_database_migration_and_secure_cookie(tmp_path):
    instance = tmp_path / "old"
    instance.mkdir()
    db = sqlite3.connect(instance / "mynote.sqlite3")
    db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT, password_hash TEXT, is_admin INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at TEXT)")
    db.execute("INSERT INTO users(id, username, display_name, password_hash) VALUES (1, 'legacy', 'Original', 'unused')")
    db.commit()
    db.close()
    app = create_app({"TESTING": True, "INSTANCE_PATH": str(instance), "SESSION_COOKIE_SECURE": True})
    with app.app_context():
        init_app_database()
        user = get_db().execute("SELECT * FROM users WHERE id = 1").fetchone()
        assert user["display_name"] == "Original"
        assert user["auth_version"] == 0 and user["totp_secret"] is None
    response = app.test_client().get("/api/session", base_url="https://note.example.com")
    assert "Secure;" in response.headers["Set-Cookie"]
