from __future__ import annotations

import base64
import io
import secrets

import click
import pyotp
import qrcode
import qrcode.image.svg
from flask import jsonify, request, session

from .db import get_db
from .routes import api, login_required, _start_authenticated_session, _user_json, _csrf_token, _clear_login_failures, _client_ip
from .security import (
    SecurityError, atomic, check_limit, current_user_locked, decrypt, digest,
    encrypt, fail, new_recovery_codes, now, require_password, reset_mfa,
    revoke_sessions, totp_step, verify_factor,
)


def start_challenge(user):
    token = secrets.token_urlsafe(32)
    with atomic() as db:
        fresh = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        if not fresh or not fresh["is_active"] or fresh["auth_version"] != user["auth_version"]:
            raise SecurityError("账号状态已变化，请重新登录", "login_required", 401)
        check_limit(user["id"])
        db.execute("DELETE FROM mfa_challenges WHERE expires_at <= ?", (now(),))
        # Keep only a bounded number of concurrent pending logins per account.
        db.execute("DELETE FROM mfa_challenges WHERE token_hash IN (SELECT token_hash FROM "
                   "mfa_challenges WHERE user_id = ? ORDER BY expires_at DESC LIMIT -1 OFFSET 9)", (user["id"],))
        db.execute("INSERT INTO mfa_challenges VALUES (?, ?, ?, ?)",
                   (digest(token), user["id"], user["auth_version"], now() + 300))
    session.clear()
    session["mfa_challenge"] = token
    return jsonify(mfa_required=True, csrf_token=_csrf_token())


@api.post("/mfa/login")
def verify_login():
    data = request.get_json(silent=True) or {}
    with atomic() as db:
        token_hash = digest(session.get("mfa_challenge", ""))
        challenge = db.execute("SELECT * FROM mfa_challenges WHERE token_hash = ?", (token_hash,)).fetchone()
        user = db.execute("SELECT * FROM users WHERE id = ?", (challenge["user_id"],)).fetchone() if challenge else None
        if not user or not user["is_active"] or not user["totp_secret"] or challenge["expires_at"] <= now() or challenge["auth_version"] != user["auth_version"]:
            session.clear()
            raise SecurityError("验证已过期，请重新输入账号密码", "mfa_expired", 401)
        verify_factor(user, data)
        db.execute("DELETE FROM mfa_challenges WHERE token_hash = ?", (token_hash,))
    _clear_login_failures(_client_ip())
    _start_authenticated_session(user["id"], user["auth_version"])
    return jsonify(user=_user_json(user), csrf_token=_csrf_token())


@api.post("/mfa/cancel")
def cancel_login():
    with atomic() as db:
        db.execute("DELETE FROM mfa_challenges WHERE token_hash = ?", (digest(session.get("mfa_challenge", "")),))
    session.pop("mfa_challenge", None)
    return jsonify(ok=True, csrf_token=_csrf_token())


@api.get("/mfa")
@login_required
def status():
    user = current_user_locked()
    count = get_db().execute("SELECT COUNT(*) FROM recovery_codes WHERE user_id = ?", (user["id"],)).fetchone()[0]
    return jsonify(enabled=bool(user["totp_secret"]), recovery_codes_remaining=count)


@api.post("/mfa/setup")
@login_required
def setup():
    data = request.get_json(silent=True) or {}
    with atomic() as db:
        user = current_user_locked()
        require_password(user, data)
        if user["totp_secret"]:
            raise SecurityError("请先验证身份并关闭现有验证器，再绑定新设备")
        secret = pyotp.random_base32()
        encrypted = encrypt(secret)
        db.execute("UPDATE users SET totp_pending_secret = ?, totp_pending_until = ? WHERE id = ?",
                   (encrypted, now() + 600, user["id"]))
    uri = pyotp.TOTP(secret).provisioning_uri(name=user["username"], issuer_name="MyNote")
    buffer = io.BytesIO()
    qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage).save(buffer)
    return jsonify(secret=secret, qr_code="data:image/svg+xml;base64," + base64.b64encode(buffer.getvalue()).decode())


def finish_change(user, **extra):
    # Use the verified version; a simultaneous later reset must invalidate it.
    _start_authenticated_session(user["id"], user["auth_version"] + 1)
    return jsonify(ok=True, csrf_token=_csrf_token(), **extra)


@api.post("/mfa/enable")
@login_required
def enable():
    data = request.get_json(silent=True) or {}
    with atomic() as db:
        user = current_user_locked()
        check_limit(user["id"])
        if user["totp_secret"] or not user["totp_pending_secret"] or user["totp_pending_until"] <= now():
            raise SecurityError("绑定已过期，请重新开始", "setup_expired")
        step = totp_step(decrypt(user["totp_pending_secret"]), data.get("code", ""))
        if step is None:
            fail(user["id"])
        db.execute("UPDATE users SET totp_secret = totp_pending_secret, totp_last_step = ? WHERE id = ?", (step, user["id"]))
        codes = new_recovery_codes(user["id"])
        revoke_sessions(user["id"])
    return finish_change(user, recovery_codes=codes)


@api.post("/mfa/disable")
@login_required
def disable():
    data = request.get_json(silent=True) or {}
    with atomic():
        user = current_user_locked()
        require_password(user, data)
        if not user["totp_secret"]:
            raise SecurityError("尚未开启二次验证")
        verify_factor(user, data)
        reset_mfa(user["id"])
    return finish_change(user)


@api.post("/mfa/recovery-codes")
@login_required
def regenerate_codes():
    data = request.get_json(silent=True) or {}
    with atomic():
        user = current_user_locked()
        require_password(user, data)
        if not user["totp_secret"]:
            raise SecurityError("请先开启二次验证")
        verify_factor(user, data)
        codes = new_recovery_codes(user["id"])
        revoke_sessions(user["id"])
    return finish_change(user, recovery_codes=codes)


def init_security(app):
    @app.errorhandler(SecurityError)
    def security_error(error):
        response = jsonify(error=error.message, code=error.code, csrf_token=_csrf_token())
        response.status_code = error.status
        if error.status == 429:
            response.headers["Retry-After"] = "900"
        return response

    @app.after_request
    def private_response(response):
        if request.path.startswith("/api/") or request.path == "/":
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        return response

    @app.cli.command("reset-mfa")
    @click.argument("username")
    @click.option("--yes", is_flag=True, help="确认在服务器本地重置二次验证")
    def reset_command(username, yes):
        """Emergency local recovery. Requires direct access to the server."""
        if not yes:
            click.confirm(f"重置 {username} 的二次验证、恢复码并撤销所有登录？", abort=True)
        with atomic() as db:
            user = db.execute("SELECT id FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
            if not user:
                raise click.ClickException("账号不存在")
            reset_mfa(user["id"])
            db.execute("DELETE FROM security_attempts WHERE bucket = ?", (f"user:{user['id']}",))
        click.echo("二次验证已重置，所有旧登录已失效。请使用密码登录并重新绑定验证器。")
