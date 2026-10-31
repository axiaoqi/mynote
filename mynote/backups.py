"""Encrypted account backups, persisted scheduling and bounded retention."""
from __future__ import annotations

import os
import hashlib
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from flask import current_app, jsonify, request, send_file

from .db import get_db
from .routes import api, build_backup, login_required
from .security import SecurityError, atomic, current_user_locked, now, check_limit, fail
from .vault import require_vault

BEIJING = timezone(timedelta(hours=8))


def init_backup_database():
    get_db().executescript("""
        CREATE TABLE IF NOT EXISTS backup_settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0,
            interval_days INTEGER NOT NULL DEFAULT 1,
            time_of_day TEXT NOT NULL DEFAULT '03:00',
            retention_days INTEGER NOT NULL DEFAULT 30,
            password TEXT NOT NULL,
            next_run INTEGER NOT NULL,
            running_until INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 1,
            last_success INTEGER,
            last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS backup_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            size INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_directories (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            directory_name TEXT NOT NULL UNIQUE
        );
    """)
    # Migrate existing account folders before starting the backup worker.
    for user in get_db().execute('SELECT id FROM users').fetchall():
        legacy = Path(current_app.instance_path) / 'backups' / str(user['id'])
        if legacy.exists():
            backup_directory(user['id'])


def password_cipher():
    path = Path(current_app.instance_path) / '.backup_key'
    if not path.exists():
        if get_db().execute('SELECT 1 FROM backup_settings LIMIT 1').fetchone():
            raise SecurityError('备份密钥缺失，请恢复 .backup_key', 'backup_key_unavailable', 503)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(Fernet.generate_key())
        except FileExistsError:
            pass
    try:
        return Fernet(path.read_bytes().strip())
    except ValueError:
        raise SecurityError('备份密钥无效', 'backup_key_unavailable', 503) from None


def next_run(time_of_day, interval_days=1, after=None):
    instant = datetime.fromtimestamp(now() if after is None else after, BEIJING)
    hour, minute = map(int, time_of_day.split(':'))
    scheduled = instant.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if scheduled <= instant:
        scheduled += timedelta(days=interval_days)
    return int(scheduled.timestamp())


def directory_name(username, user_id):
    # Keep Chinese, ASCII letters/digits, underscore and hyphen. No separators,
    # dots or Windows device names can become a directory component.
    cleaned = re.sub(r'[^A-Za-z0-9_\-\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0002fa1f]', '_', username)[:24]
    return f'{cleaned or "user"}_{user_id}'


def _account_directory(name):
    root = (Path(current_app.instance_path) / 'backups').resolve()
    path = root / name
    if path.is_symlink() or path.is_junction() or path.resolve().parent != root:
        raise OSError('备份目录路径无效，不能指向其他目录')
    return path


def backup_directory(user_id):
    db = get_db()
    with atomic():
        row = db.execute('SELECT directory_name FROM backup_directories WHERE user_id = ?', (user_id,)).fetchone()
        if row is None:
            user = db.execute('SELECT username FROM users WHERE id = ?', (user_id,)).fetchone()
            if user is None:
                raise OSError('备份账号不存在')
            name = directory_name(user['username'], user_id)
            db.execute('INSERT INTO backup_directories VALUES (?, ?)', (user_id, name))
        else:
            name = row['directory_name']
    # Persist the name first so an interrupted migration can safely resume,
    # even if the username is subsequently changed.
    with atomic():
        source = _account_directory(str(user_id))
        target = _account_directory(name)
        if source.exists():
            if not target.exists():
                source.rename(target)
            else:
                # A previous migration may have stopped partway through. Never
                # overwrite a different backup at the destination.
                for old_file in source.iterdir():
                    if old_file.is_symlink() or not old_file.is_file():
                        raise OSError('旧备份目录包含非普通文件，请检查备份目录')
                    new_file = target / old_file.name
                    if new_file.exists():
                        if new_file.is_symlink() or not new_file.is_file():
                            raise OSError('备份迁移目标无效')
                        identical = old_file.stat().st_size == new_file.stat().st_size
                        if identical:
                            with old_file.open('rb') as old_stream, new_file.open('rb') as new_stream:
                                identical = hashlib.file_digest(old_stream, 'sha256').digest() == hashlib.file_digest(new_stream, 'sha256').digest()
                        if not identical:
                            raise OSError('备份迁移遇到同名不同内容文件，已保留两份文件')
                        old_file.unlink()
                    else:
                        old_file.rename(new_file)
                source.rmdir()
    return target


def backup_path(user_id, filename):
    return backup_directory(user_id) / filename


def prune_backups(user_id, retention_days):
    db = get_db()
    rows = db.execute('SELECT * FROM backup_files WHERE user_id = ? AND created_at <= ?',
                      (user_id, now() - retention_days * 86400)).fetchall()
    folder = backup_directory(user_id) if rows else None
    for row in rows:
        (folder / row['filename']).unlink(missing_ok=True)
        db.execute('DELETE FROM backup_files WHERE id = ?', (row['id'],))
    db.commit()


def run_backup(user_id, manual=False):
    with atomic() as db:
        config = db.execute('SELECT b.* FROM backup_settings b JOIN users u ON b.user_id = u.id WHERE b.user_id = ? AND u.is_active = 1', (user_id,)).fetchone()
        if not config or (not manual and (not config['enabled'] or config['next_run'] > now())):
            return False
        if config['running_until'] > now():
            if manual:
                raise SecurityError('备份正在进行，请稍后刷新', 'backup_busy', 409)
            return False
        db.execute('UPDATE backup_settings SET running_until = ? WHERE user_id = ?', (now() + 3600, user_id))
    path = None
    temp = None
    recorded = False
    try:
        password = password_cipher().decrypt(config['password'].encode()).decode()
        # Keep notes, groups and credentials in one SQLite read snapshot.
        db.execute('BEGIN')
        output = build_backup(user_id, password)
        db.commit()
        filename = datetime.fromtimestamp(now(), BEIJING).strftime('mynote-%Y%m%d-%H%M%S-') + secrets.token_hex(6) + '.zip'
        path = backup_path(user_id, filename)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_bytes(output.getvalue())
        temp.replace(path)
        with atomic() as db:
            db.execute('INSERT INTO backup_files(user_id, filename, created_at, size) VALUES (?, ?, ?, ?)',
                       (user_id, filename, now(), path.stat().st_size))
            scheduled = config['next_run'] if manual and config['next_run'] > now() else next_run(config['time_of_day'], config['interval_days'])
            db.execute('UPDATE backup_settings SET running_until = 0, last_success = ?, last_error = NULL, next_run = ? WHERE user_id = ? AND revision = ?',
                       (now(), scheduled, user_id, config['revision']))
        recorded = True
        prune_backups(user_id, config['retention_days'])
        return True
    except Exception as error:
        db.rollback()
        if temp:
            temp.unlink(missing_ok=True)
        if path and not recorded:
            path.unlink(missing_ok=True)
        # Never include passwords or credential contents in logs/status.
        current_app.logger.error('Account backup failed (user_id=%s, error_type=%s)', user_id, type(error).__name__)
        with atomic() as db:
            db.execute('UPDATE backup_settings SET running_until = 0, last_error = ?, next_run = ? WHERE user_id = ? AND revision = ?',
                       ('备份失败，请检查磁盘空间、数据目录权限和加密密钥', now() + 300, user_id, config['revision']))
        if manual:
            raise SecurityError('备份失败，请检查磁盘空间、数据目录权限和加密密钥', 'backup_failed', 503) from None
        return False


def backup_tick():
    rows = get_db().execute('SELECT user_id, retention_days FROM backup_settings').fetchall()
    for row in rows:
        try:
            run_backup(row['user_id'])
            prune_backups(row['user_id'], row['retention_days'])
        except Exception:
            get_db().rollback()
            current_app.logger.error('Backup maintenance failed (user_id=%s)', row['user_id'])


def start_backup_worker(app):
    if app.testing or app.config.get('BACKUP_WORKER_DISABLED'):
        return
    def loop():
        while True:
            try:
                with app.app_context():
                    backup_tick()
            except Exception:
                app.logger.error('Backup scheduler failed; retrying in 30 seconds')
            threading.Event().wait(30)
    threading.Thread(target=loop, daemon=True, name='mynote-backups').start()


@api.get('/backups')
@login_required
def backup_status():
    user_id = request.current_user['id']
    row = get_db().execute('SELECT * FROM backup_settings WHERE user_id = ?', (user_id,)).fetchone()
    fields = ('enabled', 'interval_days', 'time_of_day', 'retention_days', 'next_run', 'last_success', 'last_error')
    config = {key: row[key] for key in fields} if row else dict(enabled=False, interval_days=1, time_of_day='03:00', retention_days=30)
    config['password_set'] = bool(row)
    folder = get_db().execute('SELECT directory_name FROM backup_directories WHERE user_id = ?', (user_id,)).fetchone()
    username = request.current_user['username']
    config['directory'] = 'instance/backups/' + (folder['directory_name'] if folder else directory_name(username, user_id)) + '/'
    files = get_db().execute('SELECT id, filename, created_at, size FROM backup_files WHERE user_id = ? ORDER BY created_at DESC, id DESC', (user_id,)).fetchall()
    available, missing = [], []
    try:
        directory = backup_directory(user_id) if files else None
    except OSError:
        raise SecurityError('无法读取备份目录，请检查磁盘和目录权限', 'backup_directory_unavailable', 503) from None
    for file in files:
        try:
            exists = (directory / file['filename']).is_file()
        except OSError:
            # An inaccessible volume must not be treated as a deleted backup.
            raise SecurityError('无法读取备份目录，请检查磁盘和目录权限', 'backup_directory_unavailable', 503) from None
        if exists:
            available.append(dict(file))
        else:
            missing.append((file['id'], user_id))
    if missing:
        with atomic() as db:
            db.executemany('DELETE FROM backup_files WHERE id = ? AND user_id = ?', missing)
    return jsonify(config=config, files=available)


@api.put('/backups')
@login_required
def backup_settings():
    data = request.get_json(silent=True) or {}
    try:
        interval = int(data.get('interval_days', 1))
        retention = int(data.get('retention_days', 30))
        time_of_day = str(data.get('time_of_day', '03:00'))
        if len(time_of_day) != 5 or datetime.strptime(time_of_day, '%H:%M').strftime('%H:%M') != time_of_day:
            raise ValueError()
        if not 1 <= interval <= 30 or not 1 <= retention <= 30 or not isinstance(data.get('enabled'), bool):
            raise ValueError()
    except (ValueError, TypeError):
        raise SecurityError('时间格式需为 HH:MM，周期和保留天数需为 1–30 天', 'invalid_backup_settings') from None
    password = str(data.get('password', ''))
    if password and not 8 <= len(password) <= 128:
        raise SecurityError('ZIP 密码长度需为 8–128 位', 'invalid_password')
    with atomic() as db:
        user = current_user_locked()
        if db.execute('SELECT 1 FROM vault_settings WHERE user_id = ?', (user['id'],)).fetchone():
            require_vault(user)
        row = db.execute('SELECT * FROM backup_settings WHERE user_id = ?', (user['id'],)).fetchone()
        if row and row['running_until'] > now():
            raise SecurityError('备份正在进行，请稍后修改设置', 'backup_busy', 409)
        if not password and not row:
            raise SecurityError('请先设置 ZIP 解压密码', 'zip_password_required')
        if password and row:
            check_limit(user['id'])
            previous = str(data.get('current_password', ''))
            try:
                stored_password = password_cipher().decrypt(row['password'].encode())
            except InvalidToken:
                raise SecurityError('无法读取已保存的备份密码，请恢复正确的 .backup_key', 'backup_key_unavailable', 503) from None
            if len(previous) > 128 or not secrets.compare_digest(previous.encode('utf-8'), stored_password):
                try:
                    fail(user['id'])
                except SecurityError as error:
                    if error.status == 429:
                        raise
                    raise SecurityError('原 ZIP 解压密码不正确', 'backup_password_incorrect') from None
        encrypted = password_cipher().encrypt(password.encode()).decode() if password else row['password']
        db.execute('''INSERT INTO backup_settings(user_id, enabled, interval_days, time_of_day, retention_days, password, next_run)
                      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
                      enabled=excluded.enabled, interval_days=excluded.interval_days, time_of_day=excluded.time_of_day,
                      retention_days=excluded.retention_days, password=excluded.password, next_run=excluded.next_run,
                      revision=backup_settings.revision+1, last_error=NULL''',
                   (user['id'], data['enabled'], interval, time_of_day, retention, encrypted, next_run(time_of_day)))
    prune_backups(user['id'], retention)
    return jsonify(ok=True)


@api.post('/backups/run')
@login_required
def backup_now():
    if not run_backup(request.current_user['id'], manual=True):
        raise SecurityError('请先保存自动备份设置和解压密码', 'backup_not_configured')
    return jsonify(ok=True)


@api.get('/backups/<int:backup_id>')
@login_required
def backup_download(backup_id):
    row = get_db().execute('SELECT * FROM backup_files WHERE id = ? AND user_id = ?', (backup_id, request.current_user['id'])).fetchone()
    if not row or not backup_path(row['user_id'], row['filename']).is_file():
        raise SecurityError('备份不存在或已过期', 'not_found', 404)
    return send_file(backup_path(row['user_id'], row['filename']), mimetype='application/zip', as_attachment=True, download_name=row['filename'])
