from __future__ import annotations

import html
import sqlite3
from pathlib import Path

from flask import current_app, g


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(user_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES note_groups(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '',
    plain_text TEXT NOT NULL DEFAULT '',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    stored_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_user_state_updated
ON notes(user_id, is_deleted, is_pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_group
ON notes(user_id, group_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_attachments_note
ON attachments(note_id);
"""


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        db_path = Path(current_app.config["DATABASE"])
        db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(db_path, timeout=8)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 8000")
        g.db = connection
    return g.db


def close_db(_error=None) -> None:
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def init_app_database() -> None:
    db = get_db()
    db.execute("PRAGMA journal_mode = WAL")
    db.executescript(SCHEMA)
    db.execute(
        "INSERT OR IGNORE INTO app_settings(key, value) VALUES ('registration_open', '1')"
    )
    migrated = db.execute(
        "SELECT 1 FROM app_settings WHERE key = 'notes_without_titles_v1'"
    ).fetchone()
    if not migrated:
        legacy_notes = db.execute(
            "SELECT id, title, content_html, plain_text FROM notes WHERE trim(title) <> ''"
        ).fetchall()
        for note in legacy_notes:
            title = note["title"].strip()
            content_html = note["content_html"] or ""
            plain_text = note["plain_text"] or ""
            if title == "新建便签" and not plain_text:
                merged_html = content_html
                merged_text = plain_text
            else:
                merged_html = f"<p><strong>{html.escape(title)}</strong></p>{content_html}"
                merged_text = f"{title}\n{plain_text}".strip()
            db.execute(
                "UPDATE notes SET title = '', content_html = ?, plain_text = ? WHERE id = ?",
                (merged_html, merged_text, note["id"]),
            )
        db.execute(
            "INSERT INTO app_settings(key, value) VALUES ('notes_without_titles_v1', '1')"
        )
    db.commit()


def setting(key: str, default: str | None = None) -> str | None:
    row = get_db().execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    db = get_db()
    db.execute(
        "INSERT INTO app_settings(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    db.commit()
