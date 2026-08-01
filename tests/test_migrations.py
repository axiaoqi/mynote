from __future__ import annotations

from mynote.db import get_db, init_app_database


def test_existing_note_names_are_preserved_in_content(app):
    with app.app_context():
        db = get_db()
        db.execute("DELETE FROM app_settings WHERE key = 'notes_without_titles_v1'")
        user_id = db.execute(
            "INSERT INTO users(username, display_name, password_hash) VALUES ('legacy', '旧用户', 'unused')"
        ).lastrowid
        note_id = db.execute(
            "INSERT INTO notes(user_id, title, content_html, plain_text) VALUES (?, '原便签名称', '<p>原正文</p>', '原正文')",
            (user_id,),
        ).lastrowid
        db.commit()

        init_app_database()
        note = db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        assert note["title"] == ""
        assert "原便签名称" in note["content_html"]
        assert note["plain_text"].startswith("原便签名称\n")
