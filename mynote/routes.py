from __future__ import annotations

import html
import io
import json
import mimetypes
import re
import secrets
import sqlite3
import uuid
import zipfile
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path, PurePosixPath

import markdown
from flask import (
    Blueprint,
    Response,
    abort,
    current_app,
    jsonify,
    render_template,
    request,
    send_file,
    session,
)
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from .content import html_to_text, plain_to_html, safe_filename_part, sanitize_html
from .db import get_db, set_setting, setting


pages = Blueprint("pages", __name__)
api = Blueprint("api", __name__, url_prefix="/api")

IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
USERNAME_RE = re.compile(r"^[\w\u3400-\u9fff.-]{3,32}$", re.UNICODE)


def _matches_image_signature(raw: bytes, mime_type: str) -> bool:
    if mime_type == "image/png":
        return raw.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return raw.startswith(b"\xff\xd8\xff")
    if mime_type == "image/gif":
        return raw.startswith((b"GIF87a", b"GIF89a"))
    if mime_type == "image/webp":
        return len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    return False


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _csrf_token() -> str:
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return session["csrf_token"]


def _start_authenticated_session(user_id: int) -> None:
    session.clear()
    session.permanent = True
    session["user_id"] = user_id
    session["csrf_token"] = secrets.token_urlsafe(32)


@pages.get("/")
def index():
    return render_template("index.html", csrf_token=_csrf_token())


@api.before_request
def csrf_guard():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        expected = session.get("csrf_token")
        provided = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
        if not expected or not provided or not secrets.compare_digest(expected, provided):
            return jsonify(error="安全令牌无效，请刷新页面后重试", code="csrf_failed"), 403


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user_id = session.get("user_id")
        if not user_id:
            return jsonify(error="请先登录", code="login_required"), 401
        user = get_db().execute(
            "SELECT id, username, display_name, is_admin, is_active, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not user or not user["is_active"]:
            session.clear()
            return jsonify(error="账号不可用，请重新登录", code="account_inactive"), 401
        request.current_user = user
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if not request.current_user["is_admin"]:
            return jsonify(error="需要管理员权限", code="admin_required"), 403
        return view(*args, **kwargs)
    return wrapped


def _user_json(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "is_admin": bool(row["is_admin"]),
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"],
    }


def _group_json(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "sort_order": row["sort_order"],
        "note_count": row["note_count"] if "note_count" in row.keys() else 0,
        "updated_at": row["updated_at"],
    }


def _note_json(row, detail: bool = True) -> dict:
    result = {
        "id": row["id"],
        "group_id": row["group_id"],
        "preview": row["plain_text"][:140],
        "is_pinned": bool(row["is_pinned"]),
        "is_deleted": bool(row["is_deleted"]),
        "version": row["version"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "deleted_at": row["deleted_at"],
    }
    if detail:
        result["content_html"] = row["content_html"]
    return result


@api.get("/session")
def session_status():
    response = {
        "authenticated": False,
        "registration_open": setting("registration_open", "1") == "1",
    }
    user_id = session.get("user_id")
    if user_id:
        user = get_db().execute(
            "SELECT id, username, display_name, is_admin, is_active, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if user and user["is_active"]:
            # Upgrade cookies created by versions that used browser-session
            # cookies. Marking the session permanent causes Flask to resend it
            # with the configured expiry date.
            if not session.permanent:
                session.permanent = True
            response.update(authenticated=True, user=_user_json(user))
        else:
            session.clear()
    response["csrf_token"] = _csrf_token()
    return jsonify(response)


@api.post("/register")
def register():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    display_name = str(data.get("display_name", "")).strip() or username
    password = str(data.get("password", ""))
    db = get_db()
    user_count = db.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
    if user_count and setting("registration_open", "1") != "1":
        return jsonify(error="管理员已关闭新用户注册", code="registration_closed"), 403
    if not USERNAME_RE.fullmatch(username):
        return jsonify(error="用户名需为 3–32 位中文、字母、数字、点、横线或下划线", code="invalid_username"), 400
    if len(display_name) > 40:
        return jsonify(error="昵称不能超过 40 个字符", code="invalid_display_name"), 400
    if len(password) < 8 or len(password) > 128:
        return jsonify(error="密码长度需为 8–128 位", code="invalid_password"), 400
    try:
        cursor = db.execute(
            "INSERT INTO users(username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)",
            (username, display_name, generate_password_hash(password), 1 if user_count == 0 else 0),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="该用户名已被使用", code="username_taken"), 409
    _start_authenticated_session(cursor.lastrowid)
    user = db.execute(
        "SELECT id, username, display_name, is_admin, is_active, created_at FROM users WHERE id = ?",
        (cursor.lastrowid,),
    ).fetchone()
    return jsonify(user=_user_json(user), csrf_token=session["csrf_token"]), 201


@api.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    user = get_db().execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify(error="用户名或密码错误", code="invalid_credentials"), 401
    if not user["is_active"]:
        return jsonify(error="账号已被停用，请联系管理员", code="account_inactive"), 403
    _start_authenticated_session(user["id"])
    return jsonify(user=_user_json(user), csrf_token=session["csrf_token"])


@api.post("/logout")
@login_required
def logout():
    session.clear()
    return jsonify(ok=True)


@api.patch("/account")
@login_required
def update_account():
    data = request.get_json(silent=True) or {}
    db = get_db()
    user_id = request.current_user["id"]
    if "display_name" in data:
        display_name = str(data["display_name"]).strip()
        if not display_name or len(display_name) > 40:
            return jsonify(error="昵称需为 1–40 个字符", code="invalid_display_name"), 400
        db.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name, user_id))
    if data.get("new_password"):
        row = db.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if not check_password_hash(row["password_hash"], str(data.get("current_password", ""))):
            return jsonify(error="当前密码不正确", code="invalid_current_password"), 400
        new_password = str(data["new_password"])
        if len(new_password) < 8 or len(new_password) > 128:
            return jsonify(error="新密码长度需为 8–128 位", code="invalid_password"), 400
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(new_password), user_id))
    db.commit()
    user = db.execute(
        "SELECT id, username, display_name, is_admin, is_active, created_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return jsonify(user=_user_json(user))


@api.get("/admin/users")
@admin_required
def admin_users():
    rows = get_db().execute(
        "SELECT id, username, display_name, is_admin, is_active, created_at FROM users ORDER BY id"
    ).fetchall()
    return jsonify(
        users=[_user_json(row) for row in rows],
        registration_open=setting("registration_open", "1") == "1",
    )


@api.patch("/admin/registration")
@admin_required
def admin_registration():
    data = request.get_json(silent=True) or {}
    value = bool(data.get("open"))
    set_setting("registration_open", "1" if value else "0")
    return jsonify(registration_open=value)


@api.patch("/admin/users/<int:user_id>")
@admin_required
def admin_update_user(user_id: int):
    if user_id == request.current_user["id"]:
        return jsonify(error="不能停用当前管理员账号", code="cannot_disable_self"), 400
    data = request.get_json(silent=True) or {}
    if "is_active" not in data:
        return jsonify(error="缺少 is_active", code="invalid_request"), 400
    db = get_db()
    cursor = db.execute("UPDATE users SET is_active = ? WHERE id = ?", (1 if data["is_active"] else 0, user_id))
    db.commit()
    if not cursor.rowcount:
        return jsonify(error="用户不存在", code="not_found"), 404
    return jsonify(ok=True)


@api.get("/groups")
@login_required
def list_groups():
    rows = get_db().execute(
        """
        SELECT g.*, COUNT(n.id) AS note_count
        FROM note_groups g
        LEFT JOIN notes n ON n.group_id = g.id AND n.is_deleted = 0
        WHERE g.user_id = ?
        GROUP BY g.id
        ORDER BY g.sort_order, g.created_at
        """,
        (request.current_user["id"],),
    ).fetchall()
    return jsonify(groups=[_group_json(row) for row in rows])


@api.post("/groups")
@login_required
def create_group():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name or len(name) > 50:
        return jsonify(error="分组名称需为 1–50 个字符", code="invalid_name"), 400
    db = get_db()
    order = db.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM note_groups WHERE user_id = ?",
        (request.current_user["id"],),
    ).fetchone()["next_order"]
    try:
        cursor = db.execute(
            "INSERT INTO note_groups(user_id, name, sort_order) VALUES (?, ?, ?)",
            (request.current_user["id"], name, order),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="已有同名分组", code="duplicate_group"), 409
    row = db.execute("SELECT *, 0 AS note_count FROM note_groups WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify(group=_group_json(row)), 201


@api.patch("/groups/<int:group_id>")
@login_required
def update_group(group_id: int):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name or len(name) > 50:
        return jsonify(error="分组名称需为 1–50 个字符", code="invalid_name"), 400
    db = get_db()
    try:
        cursor = db.execute(
            "UPDATE note_groups SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (name, utcnow(), group_id, request.current_user["id"]),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="已有同名分组", code="duplicate_group"), 409
    if not cursor.rowcount:
        return jsonify(error="分组不存在", code="not_found"), 404
    return jsonify(ok=True)


@api.delete("/groups/<int:group_id>")
@login_required
def delete_group(group_id: int):
    db = get_db()
    cursor = db.execute(
        "DELETE FROM note_groups WHERE id = ? AND user_id = ?",
        (group_id, request.current_user["id"]),
    )
    db.commit()
    if not cursor.rowcount:
        return jsonify(error="分组不存在", code="not_found"), 404
    return jsonify(ok=True)


@api.get("/notes")
@login_required
def list_notes():
    user_id = request.current_user["id"]
    trash = request.args.get("trash", "0") == "1"
    query = (request.args.get("q") or "").strip()[:100]
    group_value = request.args.get("group_id")
    clauses = ["user_id = ?", "is_deleted = ?"]
    params: list = [user_id, 1 if trash else 0]
    if not trash:
        if group_value in {None, "", "home", "ungrouped"}:
            clauses.append("group_id IS NULL")
        else:
            try:
                group_id = int(group_value)
            except ValueError:
                return jsonify(error="分组参数无效", code="invalid_group"), 400
            owned = get_db().execute(
                "SELECT 1 FROM note_groups WHERE id = ? AND user_id = ?", (group_id, user_id)
            ).fetchone()
            if not owned:
                return jsonify(error="分组不存在", code="not_found"), 404
            clauses.append("group_id = ?")
            params.append(group_id)
    if query:
        clauses.append("plain_text LIKE ? ESCAPE '\\'")
        escaped_query = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        params.append(f"%{escaped_query}%")
    rows = get_db().execute(
        f"SELECT * FROM notes WHERE {' AND '.join(clauses)} "
        "ORDER BY is_pinned DESC, updated_at DESC, id DESC LIMIT 1000",
        params,
    ).fetchall()
    return jsonify(notes=[_note_json(row, detail=False) for row in rows])


@api.post("/notes")
@login_required
def create_note():
    data = request.get_json(silent=True) or {}
    user_id = request.current_user["id"]
    group_id = data.get("group_id")
    if group_id in {"", "ungrouped"}:
        group_id = None
    if group_id is not None:
        group = get_db().execute(
            "SELECT id FROM note_groups WHERE id = ? AND user_id = ?", (group_id, user_id)
        ).fetchone()
        if not group:
            return jsonify(error="分组不存在", code="not_found"), 404
    content_html = sanitize_html(str(data.get("content_html", "")))
    now = utcnow()
    db = get_db()
    cursor = db.execute(
        """
        INSERT INTO notes(user_id, group_id, title, content_html, plain_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, group_id, "", content_html, html_to_text(content_html), now, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify(note=_note_json(row)), 201


def _owned_note(note_id: int, include_deleted: bool = True):
    sql = "SELECT * FROM notes WHERE id = ? AND user_id = ?"
    params = [note_id, request.current_user["id"]]
    if not include_deleted:
        sql += " AND is_deleted = 0"
    return get_db().execute(sql, params).fetchone()


@api.get("/notes/<int:note_id>")
@login_required
def get_note(note_id: int):
    row = _owned_note(note_id)
    if not row:
        return jsonify(error="便签不存在", code="not_found"), 404
    attachments = get_db().execute(
        "SELECT id, original_name, mime_type, size, created_at FROM attachments WHERE note_id = ? AND user_id = ?",
        (note_id, request.current_user["id"]),
    ).fetchall()
    result = _note_json(row)
    result["attachments"] = [
        {**dict(item), "url": f"/api/attachments/{item['id']}"} for item in attachments
    ]
    return jsonify(note=result)


@api.patch("/notes/<int:note_id>")
@login_required
def update_note(note_id: int):
    existing = _owned_note(note_id, include_deleted=False)
    if not existing:
        return jsonify(error="便签不存在或已在回收站", code="not_found"), 404
    data = request.get_json(silent=True) or {}
    try:
        version = int(data.get("version"))
    except (TypeError, ValueError):
        return jsonify(error="缺少便签版本号", code="version_required"), 400
    if version != existing["version"]:
        return jsonify(
            error="这条便签已在另一台设备上更新",
            code="edit_conflict",
            current=_note_json(existing),
        ), 409

    content_html = existing["content_html"]
    group_id = existing["group_id"]
    is_pinned = existing["is_pinned"]
    if "content_html" in data:
        content_html = sanitize_html(str(data["content_html"]))
    if "is_pinned" in data:
        is_pinned = 1 if data["is_pinned"] else 0
    if "group_id" in data:
        group_id = data["group_id"]
        if group_id in {"", "ungrouped"}:
            group_id = None
        if group_id is not None:
            group = get_db().execute(
                "SELECT 1 FROM note_groups WHERE id = ? AND user_id = ?",
                (group_id, request.current_user["id"]),
            ).fetchone()
            if not group:
                return jsonify(error="分组不存在", code="not_found"), 404

    now = utcnow()
    db = get_db()
    cursor = db.execute(
        """
        UPDATE notes
        SET title = '', content_html = ?, plain_text = ?, group_id = ?, is_pinned = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND version = ? AND is_deleted = 0
        """,
        (
            content_html, html_to_text(content_html), group_id, is_pinned,
            now, note_id, request.current_user["id"], version,
        ),
    )
    if not cursor.rowcount:
        db.rollback()
        current = _owned_note(note_id)
        return jsonify(error="这条便签已在另一台设备上更新", code="edit_conflict", current=_note_json(current)), 409
    db.commit()
    row = _owned_note(note_id)
    attachment_rows = db.execute(
        "SELECT id, stored_name FROM attachments WHERE note_id = ? AND user_id = ?",
        (note_id, request.current_user["id"]),
    ).fetchall()
    orphaned = [item for item in attachment_rows if f'/api/attachments/{item["id"]}' not in row["content_html"]]
    if orphaned:
        db.executemany("DELETE FROM attachments WHERE id = ?", [(item["id"],) for item in orphaned])
        db.commit()
        _remove_attachment_files(orphaned)
    return jsonify(note=_note_json(row))


@api.delete("/notes/<int:note_id>")
@login_required
def trash_note(note_id: int):
    data = request.get_json(silent=True) or {}
    expected_version = None
    if "version" in data:
        try:
            expected_version = int(data["version"])
        except (TypeError, ValueError):
            return jsonify(error="便签版本号无效", code="version_required"), 400

    existing = _owned_note(note_id, include_deleted=False)
    if not existing:
        return jsonify(error="便签不存在", code="not_found"), 404
    if expected_version is not None and expected_version != existing["version"]:
        return jsonify(
            error="这条便签已在另一台设备上更新",
            code="edit_conflict",
            current=_note_json(existing),
        ), 409

    now = utcnow()
    db = get_db()
    discard_if_blank = bool(data.get("discard_if_blank"))
    has_image = "<img" in (existing["content_html"] or "").lower()
    has_attachment = db.execute(
        "SELECT 1 FROM attachments WHERE note_id = ? AND user_id = ? LIMIT 1",
        (note_id, request.current_user["id"]),
    ).fetchone()
    version_clause = " AND version = ?" if expected_version is not None else ""
    version_params = [expected_version] if expected_version is not None else []

    if discard_if_blank and not existing["plain_text"].strip() and not has_image and not has_attachment:
        cursor = db.execute(
            "DELETE FROM notes WHERE id = ? AND user_id = ? AND is_deleted = 0" + version_clause,
            [note_id, request.current_user["id"], *version_params],
        )
        db.commit()
        if not cursor.rowcount:
            current = _owned_note(note_id, include_deleted=False)
            if current:
                return jsonify(
                    error="这条便签已在另一台设备上更新",
                    code="edit_conflict",
                    current=_note_json(current),
                ), 409
            return jsonify(error="便签不存在", code="not_found"), 404
        return jsonify(ok=True, discarded=True)

    cursor = db.execute(
        f"""
        UPDATE notes SET is_deleted = 1, deleted_at = ?, is_pinned = 0,
            version = version + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND is_deleted = 0{version_clause}
        """,
        [now, now, note_id, request.current_user["id"], *version_params],
    )
    db.commit()
    if not cursor.rowcount:
        current = _owned_note(note_id, include_deleted=False)
        if current and expected_version is not None:
            return jsonify(
                error="这条便签已在另一台设备上更新",
                code="edit_conflict",
                current=_note_json(current),
            ), 409
        return jsonify(error="便签不存在", code="not_found"), 404
    return jsonify(ok=True, discarded=False)


@api.post("/notes/<int:note_id>/restore")
@login_required
def restore_note(note_id: int):
    now = utcnow()
    db = get_db()
    cursor = db.execute(
        """
        UPDATE notes SET is_deleted = 0, deleted_at = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND is_deleted = 1
        """,
        (now, note_id, request.current_user["id"]),
    )
    db.commit()
    if not cursor.rowcount:
        return jsonify(error="回收站中没有这条便签", code="not_found"), 404
    return jsonify(ok=True)


def _remove_attachment_files(rows) -> None:
    base = Path(current_app.config["UPLOAD_FOLDER"]).resolve()
    for row in rows:
        path = (base / row["stored_name"]).resolve()
        if base in path.parents and path.exists():
            path.unlink(missing_ok=True)


@api.delete("/notes/<int:note_id>/permanent")
@login_required
def permanently_delete_note(note_id: int):
    db = get_db()
    note = db.execute(
        "SELECT id FROM notes WHERE id = ? AND user_id = ? AND is_deleted = 1",
        (note_id, request.current_user["id"]),
    ).fetchone()
    if not note:
        return jsonify(error="回收站中没有这条便签", code="not_found"), 404
    files = db.execute(
        "SELECT stored_name FROM attachments WHERE note_id = ? AND user_id = ?",
        (note_id, request.current_user["id"]),
    ).fetchall()
    db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    db.commit()
    _remove_attachment_files(files)
    return jsonify(ok=True)


@api.delete("/trash")
@login_required
def empty_trash():
    db = get_db()
    user_id = request.current_user["id"]
    files = db.execute(
        """
        SELECT a.stored_name FROM attachments a
        JOIN notes n ON n.id = a.note_id
        WHERE n.user_id = ? AND n.is_deleted = 1
        """,
        (user_id,),
    ).fetchall()
    cursor = db.execute("DELETE FROM notes WHERE user_id = ? AND is_deleted = 1", (user_id,))
    db.commit()
    _remove_attachment_files(files)
    return jsonify(ok=True, deleted=cursor.rowcount)


@api.post("/notes/<int:note_id>/attachments")
@login_required
def upload_attachment(note_id: int):
    note = _owned_note(note_id, include_deleted=False)
    if not note:
        return jsonify(error="便签不存在", code="not_found"), 404
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify(error="请选择图片", code="file_required"), 400
    mime_type = (uploaded.mimetype or mimetypes.guess_type(uploaded.filename)[0] or "").lower()
    if mime_type not in IMAGE_TYPES:
        return jsonify(error="仅支持 PNG、JPG、WEBP 和 GIF 图片", code="unsupported_file"), 415
    raw = uploaded.read(current_app.config["MAX_IMAGE_SIZE"] + 1)
    if not raw:
        return jsonify(error="图片内容为空", code="empty_file"), 400
    if len(raw) > current_app.config["MAX_IMAGE_SIZE"]:
        return jsonify(error="单张图片不能超过 10 MB", code="file_too_large"), 413
    if not _matches_image_signature(raw, mime_type):
        return jsonify(error="图片内容与文件类型不匹配", code="invalid_image"), 415
    relative_dir = Path(str(request.current_user["id"]))
    absolute_dir = Path(current_app.config["UPLOAD_FOLDER"]) / relative_dir
    absolute_dir.mkdir(parents=True, exist_ok=True)
    stored_basename = f"{uuid.uuid4().hex}{IMAGE_TYPES[mime_type]}"
    relative_path = relative_dir / stored_basename
    (absolute_dir / stored_basename).write_bytes(raw)
    original_name = secure_filename(uploaded.filename) or f"image{IMAGE_TYPES[mime_type]}"
    db = get_db()
    cursor = db.execute(
        """
        INSERT INTO attachments(user_id, note_id, stored_name, original_name, mime_type, size)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (request.current_user["id"], note_id, relative_path.as_posix(), original_name, mime_type, len(raw)),
    )
    db.commit()
    attachment_id = cursor.lastrowid
    return jsonify(
        attachment={
            "id": attachment_id,
            "original_name": original_name,
            "mime_type": mime_type,
            "size": len(raw),
            "url": f"/api/attachments/{attachment_id}",
        }
    ), 201


@api.get("/attachments/<int:attachment_id>")
@login_required
def download_attachment(attachment_id: int):
    row = get_db().execute(
        "SELECT * FROM attachments WHERE id = ? AND user_id = ?",
        (attachment_id, request.current_user["id"]),
    ).fetchone()
    if not row:
        abort(404)
    base = Path(current_app.config["UPLOAD_FOLDER"]).resolve()
    path = (base / row["stored_name"]).resolve()
    if base not in path.parents or not path.exists():
        abort(404)
    return send_file(path, mimetype=row["mime_type"], download_name=row["original_name"], max_age=3600)


@api.delete("/attachments/<int:attachment_id>")
@login_required
def delete_attachment(attachment_id: int):
    db = get_db()
    row = db.execute(
        "SELECT stored_name FROM attachments WHERE id = ? AND user_id = ?",
        (attachment_id, request.current_user["id"]),
    ).fetchone()
    if not row:
        return jsonify(error="附件不存在", code="not_found"), 404
    db.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
    db.commit()
    _remove_attachment_files([row])
    return jsonify(ok=True)


def _export_manifest(user_id: int) -> dict:
    db = get_db()
    groups = db.execute(
        "SELECT id, name, sort_order, created_at, updated_at FROM note_groups WHERE user_id = ? ORDER BY sort_order, id",
        (user_id,),
    ).fetchall()
    notes = db.execute(
        "SELECT * FROM notes WHERE user_id = ? ORDER BY created_at, id", (user_id,)
    ).fetchall()
    attachments = db.execute(
        "SELECT id, note_id, stored_name, original_name, mime_type, size, created_at FROM attachments WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    return {
        "format": "mynote-backup",
        "version": 1,
        "exported_at": utcnow(),
        "groups": [dict(row) for row in groups],
        "notes": [dict(row) for row in notes],
        "attachments": [dict(row) for row in attachments],
    }


@api.get("/export/json")
@login_required
def export_json():
    payload = json.dumps(_export_manifest(request.current_user["id"]), ensure_ascii=False, indent=2)
    return Response(
        payload,
        mimetype="application/json; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=mynote-export.json"},
    )


@api.get("/export/markdown")
@login_required
def export_markdown():
    db = get_db()
    rows = db.execute(
        "SELECT plain_text, updated_at FROM notes WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC",
        (request.current_user["id"],),
    ).fetchall()
    output = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for index, row in enumerate(rows, start=1):
            first_line = next((line.strip() for line in row["plain_text"].splitlines() if line.strip()), "")
            base = safe_filename_part(first_line, f"note-{index}")
            filename = f"{base}.md"
            suffix = 2
            while filename.lower() in used_names:
                filename = f"{base}-{suffix}.md"
                suffix += 1
            used_names.add(filename.lower())
            content = f"{row['plain_text']}\n"
            archive.writestr(filename, content.encode("utf-8"))
    output.seek(0)
    return send_file(output, mimetype="application/zip", as_attachment=True, download_name="mynote-markdown.zip")


@api.get("/export/backup")
@login_required
def export_backup():
    user_id = request.current_user["id"]
    manifest = _export_manifest(user_id)
    output = io.BytesIO()
    base = Path(current_app.config["UPLOAD_FOLDER"]).resolve()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        for item in manifest["attachments"]:
            path = (base / item["stored_name"]).resolve()
            if base in path.parents and path.exists():
                archive.write(path, f"attachments/{item['id']}/{safe_filename_part(item['original_name'], 'image')}")
    output.seek(0)
    return send_file(output, mimetype="application/zip", as_attachment=True, download_name="mynote-full-backup.zip")


def _unique_group_name(db, user_id: int, desired: str) -> str:
    base = desired.strip()[:50] or "导入分组"
    candidate = base
    counter = 2
    while db.execute(
        "SELECT 1 FROM note_groups WHERE user_id = ? AND name = ? COLLATE NOCASE", (user_id, candidate)
    ).fetchone():
        suffix = f" ({counter})"
        candidate = f"{base[:50-len(suffix)]}{suffix}"
        counter += 1
    return candidate


def _import_manifest(manifest: dict, attachment_files: dict[str, bytes] | None = None) -> tuple[int, int]:
    if manifest.get("format") != "mynote-backup" or manifest.get("version") != 1:
        raise ValueError("不是受支持的 MyNote 备份格式")
    groups = manifest.get("groups")
    notes = manifest.get("notes")
    if not isinstance(groups, list) or not isinstance(notes, list) or len(notes) > 20_000:
        raise ValueError("备份内容无效或数量过多")
    db = get_db()
    user_id = request.current_user["id"]
    group_map: dict[int, int] = {}
    note_map: dict[int, int] = {}
    try:
        for item in groups:
            if not isinstance(item, dict):
                continue
            name = _unique_group_name(db, user_id, str(item.get("name", "导入分组")))
            cursor = db.execute(
                "INSERT INTO note_groups(user_id, name, sort_order) VALUES (?, ?, ?)",
                (user_id, name, int(item.get("sort_order", 0))),
            )
            if isinstance(item.get("id"), int):
                group_map[item["id"]] = cursor.lastrowid
        now = utcnow()
        for item in notes:
            if not isinstance(item, dict):
                continue
            content = sanitize_html(str(item.get("content_html", "")))
            legacy_title = str(item.get("title", "")).strip()
            if legacy_title:
                content = f"<p><strong>{html.escape(legacy_title)}</strong></p>{content}"
            cursor = db.execute(
                """
                INSERT INTO notes(
                    user_id, group_id, title, content_html, plain_text, is_pinned,
                    is_deleted, deleted_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    group_map.get(item.get("group_id")),
                    "",
                    content,
                    html_to_text(content),
                    1 if item.get("is_pinned") else 0,
                    1 if item.get("is_deleted") else 0,
                    item.get("deleted_at") if item.get("is_deleted") else None,
                    item.get("created_at") or now,
                    item.get("updated_at") or now,
                ),
            )
            if isinstance(item.get("id"), int):
                note_map[item["id"]] = cursor.lastrowid

        if attachment_files:
            uploaded_root = Path(current_app.config["UPLOAD_FOLDER"])
            user_dir = uploaded_root / str(user_id)
            user_dir.mkdir(parents=True, exist_ok=True)
            for item in manifest.get("attachments", []):
                if not isinstance(item, dict) or item.get("note_id") not in note_map:
                    continue
                old_id = item.get("id")
                matching_key = next((key for key in attachment_files if key.startswith(f"attachments/{old_id}/")), None)
                if not matching_key:
                    continue
                raw = attachment_files[matching_key]
                mime_type = str(item.get("mime_type", ""))
                if mime_type not in IMAGE_TYPES or len(raw) > current_app.config["MAX_IMAGE_SIZE"]:
                    continue
                stored_basename = f"{uuid.uuid4().hex}{IMAGE_TYPES[mime_type]}"
                relative = Path(str(user_id)) / stored_basename
                (user_dir / stored_basename).write_bytes(raw)
                new_attachment = db.execute(
                    """
                    INSERT INTO attachments(user_id, note_id, stored_name, original_name, mime_type, size)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id, note_map[item["note_id"]], relative.as_posix(),
                        safe_filename_part(str(item.get("original_name", "image")), "image"),
                        mime_type, len(raw),
                    ),
                ).lastrowid
                old_url = f"/api/attachments/{old_id}"
                new_url = f"/api/attachments/{new_attachment}"
                db.execute(
                    "UPDATE notes SET content_html = replace(content_html, ?, ?) WHERE id = ?",
                    (old_url, new_url, note_map[item["note_id"]]),
                )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return len(group_map), len(note_map)


@api.post("/import")
@login_required
def import_notes():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify(error="请选择导入文件", code="file_required"), 400
    suffix = Path(uploaded.filename).suffix.lower()
    raw = uploaded.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        return jsonify(error="导入文件不能超过 32 MB", code="file_too_large"), 413
    try:
        if suffix == ".json":
            manifest = json.loads(raw.decode("utf-8-sig"))
            group_count, note_count = _import_manifest(manifest)
        elif suffix == ".zip":
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                members = archive.infolist()
                if len(members) > 10_000 or sum(item.file_size for item in members) > 200 * 1024 * 1024:
                    raise ValueError("备份压缩包内容过多")
                safe_members = {}
                for item in members:
                    path = PurePosixPath(item.filename)
                    if path.is_absolute() or ".." in path.parts:
                        raise ValueError("备份压缩包包含不安全路径")
                    if not item.is_dir():
                        safe_members[item.filename] = archive.read(item)
                if "manifest.json" not in safe_members:
                    raise ValueError("备份中缺少 manifest.json")
                manifest = json.loads(safe_members["manifest.json"].decode("utf-8-sig"))
                group_count, note_count = _import_manifest(manifest, safe_members)
        elif suffix in {".txt", ".md", ".markdown"}:
            text = raw.decode("utf-8-sig")
            if suffix in {".md", ".markdown"}:
                content = sanitize_html(markdown.markdown(text, extensions=["extra", "sane_lists"]))
            else:
                content = plain_to_html(text)
            now = utcnow()
            db = get_db()
            db.execute(
                """
                INSERT INTO notes(user_id, title, content_html, plain_text, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (request.current_user["id"], "", content, html_to_text(content), now, now),
            )
            db.commit()
            group_count, note_count = 0, 1
        else:
            return jsonify(error="仅支持 TXT、Markdown、JSON 或 MyNote ZIP 备份", code="unsupported_file"), 415
    except (UnicodeDecodeError, json.JSONDecodeError, zipfile.BadZipFile, ValueError) as exc:
        return jsonify(error=f"导入失败：{exc}", code="invalid_import"), 400
    return jsonify(ok=True, groups=group_count, notes=note_count)
