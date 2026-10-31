"""Per-user credential area with server-side, idle-expiring unlock grants."""
from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from flask import current_app, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from .db import get_db
from .routes import api, login_required
from .security import (SecurityError, atomic, check_limit, current_user_locked,
                       digest, fail, now, require_password)

IDLE_SECONDS = 300


def init_vault_database():
    get_db().executescript("""
        CREATE TABLE IF NOT EXISTS vault_settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            password_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vault_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_vault_entries_user ON vault_entries(user_id);
        CREATE TABLE IF NOT EXISTS vault_grants (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            auth_version INTEGER NOT NULL,
            last_used INTEGER NOT NULL
        );
    """)

    db = get_db()
    if 'default_group_name' not in {row['name'] for row in db.execute('PRAGMA table_info(vault_settings)')}:
        db.execute("ALTER TABLE vault_settings ADD COLUMN default_group_name TEXT NOT NULL DEFAULT '未分组'")
        db.commit()
    if 'default_group_migrated' not in {row['name'] for row in db.execute('PRAGMA table_info(vault_settings)')}:
        db.execute('ALTER TABLE vault_settings ADD COLUMN default_group_migrated INTEGER NOT NULL DEFAULT 0')
        db.commit()
    users = db.execute('SELECT DISTINCT user_id FROM vault_entries').fetchall()
    if users:
        from .content import plain_to_html, html_to_text
        for user in users:
            for entry in read_entries(user['user_id']):
                text = '\n'.join([entry['title'], '账号：' + entry['username'], '密码：' + entry['password'],
                                  '网址：' + entry['url'], '备注：' + entry['notes']])
                content = plain_to_html(text)
                db.execute("INSERT INTO notes(user_id, is_private, content_html, plain_text, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)",
                           (user['user_id'], content, html_to_text(content), entry['updated_at'], entry['updated_at']))
        db.execute('DELETE FROM vault_entries')
        db.commit()
    for row in db.execute('SELECT user_id FROM vault_settings WHERE default_group_migrated = 0').fetchall():
        migrate_legacy_default_group(row['user_id'])


def migrate_legacy_default_group(user_id):
    from .routes import _unique_group_name
    with atomic() as db:
        profile = db.execute('SELECT * FROM vault_settings WHERE user_id = ?', (user_id,)).fetchone()
        if not profile or profile['default_group_migrated']:
            return
        name = profile['default_group_name']
        has_notes = db.execute('SELECT 1 FROM notes WHERE user_id = ? AND is_private = 1 AND group_id IS NULL LIMIT 1', (user_id,)).fetchone()
        if name != '未分组' or has_notes:
            order = db.execute('SELECT COALESCE(MIN(sort_order), 0) - 1 FROM note_groups WHERE user_id = ? AND is_private = 1', (user_id,)).fetchone()[0]
            group_id = db.execute('INSERT INTO note_groups(user_id, name, sort_order, is_private) VALUES (?, ?, ?, 1)',
                                  (user_id, _unique_group_name(db, user_id, name, 1), order)).lastrowid
            db.execute('UPDATE notes SET group_id = ?, version = version + 1 WHERE user_id = ? AND is_private = 1 AND group_id IS NULL', (group_id, user_id))
        db.execute("UPDATE vault_settings SET default_group_name = '未分组', default_group_migrated = 1 WHERE user_id = ?", (user_id,))


def vault_cipher():
    path = Path(current_app.instance_path) / '.vault_key'
    if not path.exists():
        if get_db().execute('SELECT 1 FROM vault_entries LIMIT 1').fetchone():
            raise SecurityError('账号密码密钥缺失，请恢复 .vault_key', 'vault_key_unavailable', 503)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(Fernet.generate_key())
        except FileExistsError:
            pass
    try:
        return Fernet(path.read_bytes().strip())
    except ValueError:
        raise SecurityError('账号密码密钥无效', 'vault_key_unavailable', 503) from None


def clean_entry(data):
    if not isinstance(data, dict):
        raise ValueError('账号记录格式无效')
    limits = {'title': 200, 'username': 500, 'password': 2000, 'url': 2000, 'notes': 10000}
    result = {}
    for field, limit in limits.items():
        value = data.get(field, '')
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError(f'账号记录的 {field} 字段过长或格式无效')
        result[field] = value
    if not result['title'].strip():
        raise ValueError('请填写账号名称')
    return result


def seal_entry(data):
    return vault_cipher().encrypt(json.dumps(data, ensure_ascii=False).encode()).decode()


def read_entries(user_id):
    rows = get_db().execute('SELECT * FROM vault_entries WHERE user_id = ? ORDER BY id DESC', (user_id,)).fetchall()
    if not rows:
        return []
    cipher = vault_cipher()
    try:
        return [dict(json.loads(cipher.decrypt(row['payload'].encode())), id=row['id'], updated_at=row['updated_at']) for row in rows]
    except (InvalidToken, ValueError):
        raise SecurityError('无法解密账号密码，请恢复正确的 .vault_key', 'vault_key_unavailable', 503) from None


def grant_expires_at(user):
    row = get_db().execute('SELECT * FROM vault_grants WHERE token_hash = ? AND user_id = ?',
                          (digest(session.get('vault_token', '')), user['id'])).fetchone()
    if row and row['auth_version'] == user['auth_version'] and row['last_used'] > now() - IDLE_SECONDS:
        return row['last_used'] + IDLE_SECONDS
    return None


def grant_valid(user):
    return grant_expires_at(user) is not None


def require_vault(user, touch=False):
    if not grant_valid(user):
        raise SecurityError('请先输入账号密码的独立密码', 'vault_locked', 423)
    if touch:
        get_db().execute('UPDATE vault_grants SET last_used = ? WHERE token_hash = ?',
                         (now(), digest(session['vault_token'])))


def new_grant(user):
    db = get_db()
    db.execute('DELETE FROM vault_grants WHERE last_used <= ? OR token_hash = ?',
               (now() - IDLE_SECONDS, digest(session.get('vault_token', ''))))
    token = secrets.token_urlsafe(32)
    db.execute('INSERT INTO vault_grants VALUES (?, ?, ?, ?)',
               (digest(token), user['id'], user['auth_version'], now()))
    session['vault_token'] = token


def has_private_data(user_id):
    db = get_db()
    return bool(db.execute('SELECT 1 FROM notes WHERE user_id = ? AND is_private = 1 LIMIT 1', (user_id,)).fetchone()
                or db.execute('SELECT 1 FROM note_groups WHERE user_id = ? AND is_private = 1 LIMIT 1', (user_id,)).fetchone())


def require_private_export(user):
    if has_private_data(user['id']):
        require_vault(user)


@api.get('/vault')
@login_required
def vault_status():
    user = request.current_user
    configured = bool(get_db().execute('SELECT 1 FROM vault_settings WHERE user_id = ?', (user['id'],)).fetchone())
    return jsonify(configured=configured, unlocked=grant_valid(user), idle_seconds=IDLE_SECONDS, vault_expires_at=grant_expires_at(user))


@api.post('/vault/password')
@login_required
def vault_password():
    data = request.get_json(silent=True) or {}
    password = str(data.get('new_password', ''))
    if not 8 <= len(password) <= 128:
        raise SecurityError('访问密码长度需为 8–128 位', 'invalid_password')
    if password != str(data.get('confirm_password', '')):
        raise SecurityError('两次输入的访问密码不一致', 'invalid_password')
    with atomic() as db:
        user = current_user_locked()
        configured = db.execute('SELECT password_hash FROM vault_settings WHERE user_id = ?', (user['id'],)).fetchone()
        if configured:
            check_limit(user['id'])
            if not check_password_hash(configured['password_hash'], str(data.get('password', ''))):
                fail(user['id'])
        else:
            require_password(user, data)
        db.execute('INSERT INTO vault_settings(user_id, password_hash, default_group_migrated) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash',
                   (user['id'], generate_password_hash(password)))
        db.execute('DELETE FROM vault_grants WHERE user_id = ?', (user['id'],))
        new_grant(user)
    return jsonify(ok=True)


@api.post('/vault/unlock')
@login_required
def vault_unlock():
    data = request.get_json(silent=True) or {}
    with atomic() as db:
        user = current_user_locked()
        check_limit(user['id'])
        row = db.execute('SELECT password_hash FROM vault_settings WHERE user_id = ?', (user['id'],)).fetchone()
        password = str(data.get('password', ''))
        if not row or len(password) > 128 or not check_password_hash(row['password_hash'], password):
            fail(user['id'])
        new_grant(user)
    return jsonify(ok=True)


@api.post('/vault/lock')
@login_required
def vault_lock():
    with atomic() as db:
        db.execute('DELETE FROM vault_grants WHERE token_hash = ?', (digest(session.pop('vault_token', '')),))
    return jsonify(ok=True)


@api.post('/vault/touch')
@login_required
def vault_touch():
    with atomic():
        require_vault(current_user_locked(), touch=True)
    return jsonify(ok=True)
