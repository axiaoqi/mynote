"""Shared authentication primitives. Call database mutations inside atomic()."""
from __future__ import annotations

import hashlib
import os
import re
import secrets
import time
from contextlib import contextmanager
from pathlib import Path

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from flask import current_app, request, session
from werkzeug.security import check_password_hash

from .db import get_db


class SecurityError(Exception):
    def __init__(self, message, code="verification_failed", status=400):
        self.message, self.code, self.status = message, code, status


@contextmanager
def atomic():
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    try:
        yield db
        db.commit()
    except SecurityError:
        # Failed verification counters must survive the response.
        db.commit()
        raise
    except Exception:
        db.rollback()
        raise


def now():
    return int(time.time())


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def cipher():
    configured = current_app.config.get("MFA_ENCRYPTION_KEY")
    path = Path(current_app.instance_path) / ".mfa_key"
    if not configured:
        if not path.exists():
            stored = get_db().execute(
                "SELECT 1 FROM users WHERE totp_secret IS NOT NULL OR totp_pending_secret IS NOT NULL LIMIT 1"
            ).fetchone()
            if stored:
                raise SecurityError("二次验证密钥文件缺失，请恢复服务器的 .mfa_key 备份", "mfa_key_unavailable", 503)
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(Fernet.generate_key())
            except FileExistsError:
                pass
        configured = path.read_bytes().strip()
    try:
        return Fernet(configured)
    except (ValueError, TypeError):
        raise SecurityError("二次验证加密密钥配置无效", "mfa_key_unavailable", 503) from None


def encrypt(secret):
    return cipher().encrypt(secret.encode()).decode()


def decrypt(value):
    try:
        return cipher().decrypt(value.encode()).decode()
    except InvalidToken:
        raise SecurityError("无法读取二次验证密钥，请恢复正确的 .mfa_key", "mfa_key_unavailable", 503) from None


def session_matches(user):
    # Legacy cookies remain valid only until the first security change.
    return bool(user and user["is_active"] and session.get("auth_version", 0) == user["auth_version"])


def current_user_locked():
    user = get_db().execute("SELECT * FROM users WHERE id = ?", (session.get("user_id"),)).fetchone()
    if not session_matches(user):
        raise SecurityError("登录已失效，请重新登录", "login_required", 401)
    return user


def buckets(user_id):
    return (f"user:{user_id}", "ip:" + (request.remote_addr or "unknown"))


def check_limit(user_id):
    db = get_db()
    db.execute("DELETE FROM security_attempts WHERE reset_at <= ?", (now(),))
    for key in buckets(user_id):
        row = db.execute("SELECT failures FROM security_attempts WHERE bucket = ?", (key,)).fetchone()
        if row and row["failures"] >= current_app.config["MFA_MAX_FAILURES"]:
            raise SecurityError("验证失败次数过多，请 15 分钟后再试", "mfa_rate_limited", 429)


def fail(user_id):
    db = get_db()
    for key in buckets(user_id):
        db.execute(
            "INSERT INTO security_attempts(bucket, failures, reset_at) VALUES (?, 1, ?) "
            "ON CONFLICT(bucket) DO UPDATE SET failures = failures + 1",
            (key, now() + 900),
        )
    check_limit(user_id)
    raise SecurityError("密码或验证码不正确；已使用的动态码请等待下一次更新", "verification_failed")


def require_password(user, data):
    check_limit(user["id"])
    password = str(data.get("current_password", ""))
    if len(password) > 128 or not check_password_hash(user["password_hash"], password):
        fail(user["id"])


def totp_step(secret, code, last_step=-1):
    code = str(code).strip()
    if not re.fullmatch(r"[0-9]{6}", code):
        return None
    counter = now() // 30
    otp = pyotp.TOTP(secret)
    for step in (counter, counter - 1, counter + 1):
        if step > last_step and secrets.compare_digest(otp.at(step * 30), code):
            return step
    return None


def verify_factor(user, data):
    check_limit(user["id"])
    db = get_db()
    recovery = str(data.get("recovery_code", "")).strip().replace("-", "").upper()
    if recovery:
        if re.fullmatch(r"[0-9A-F]{32}", recovery):
            deleted = db.execute(
                "DELETE FROM recovery_codes WHERE user_id = ? AND code_hash = ?",
                (user["id"], digest(recovery)),
            ).rowcount
            if deleted:
                return
    else:
        step = totp_step(decrypt(user["totp_secret"]), data.get("code", ""), user["totp_last_step"])
        if step is not None:
            db.execute("UPDATE users SET totp_last_step = ? WHERE id = ?", (step, user["id"]))
            return
    fail(user["id"])


def new_recovery_codes(user_id):
    db = get_db()
    db.execute("DELETE FROM recovery_codes WHERE user_id = ?", (user_id,))
    codes = [secrets.token_hex(16).upper() for _ in range(10)]
    db.executemany("INSERT INTO recovery_codes(user_id, code_hash) VALUES (?, ?)",
                   [(user_id, digest(code)) for code in codes])
    return ["-".join(code[i:i + 8] for i in range(0, 32, 8)) for code in codes]


def revoke_sessions(user_id):
    db = get_db()
    db.execute("UPDATE users SET auth_version = auth_version + 1, totp_pending_secret = NULL, "
               "totp_pending_until = NULL WHERE id = ?", (user_id,))
    db.execute("DELETE FROM mfa_challenges WHERE user_id = ?", (user_id,))


def reset_mfa(user_id):
    db = get_db()
    db.execute("UPDATE users SET totp_secret = NULL, totp_last_step = -1 WHERE id = ?", (user_id,))
    db.execute("DELETE FROM recovery_codes WHERE user_id = ?", (user_id,))
    revoke_sessions(user_id)
