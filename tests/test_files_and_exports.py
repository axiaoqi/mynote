from __future__ import annotations

import io
import json
import zipfile

from tests.conftest import api_request, register
from tests.test_notes import create_note


PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_image_upload_access_control_and_orphan_cleanup(app, client):
    register(client)
    note = create_note(client)
    uploaded = api_request(
        client,
        "POST",
        f"/api/notes/{note['id']}/attachments",
        data={"file": (io.BytesIO(PNG_1X1), "pixel.png")},
        content_type="multipart/form-data",
    )
    assert uploaded.status_code == 201
    attachment = uploaded.get_json()["attachment"]
    assert client.get(attachment["url"]).status_code == 200

    other = app.test_client()
    register(other, "family", "familypass123", "家人")
    assert other.get(attachment["url"]).status_code == 404

    detail = client.get(f"/api/notes/{note['id']}").get_json()["note"]
    keep = api_request(
        client,
        "PATCH",
        f"/api/notes/{note['id']}",
        json={"version": detail["version"], "content_html": f'<p>图</p><img src="{attachment["url"]}">'},
    )
    assert keep.status_code == 200
    remove = api_request(
        client,
        "PATCH",
        f"/api/notes/{note['id']}",
        json={"version": keep.get_json()["note"]["version"], "content_html": "<p>图片已移除</p>"},
    )
    assert remove.status_code == 200
    assert client.get(attachment["url"]).status_code == 404


def test_rejects_fake_image(client):
    register(client)
    note = create_note(client)
    response = api_request(
        client,
        "POST",
        f"/api/notes/{note['id']}/attachments",
        data={"file": (io.BytesIO(b"<script>bad</script>"), "fake.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 415
    assert response.get_json()["code"] == "invalid_image"


def test_text_markdown_json_and_zip_roundtrip(app, client):
    register(client)
    txt = api_request(
        client,
        "POST",
        "/api/import",
        data={"file": (io.BytesIO("第一行\n\n第二行".encode()), "文本.txt")},
        content_type="multipart/form-data",
    )
    assert txt.status_code == 200
    md = api_request(
        client,
        "POST",
        "/api/import",
        data={"file": (io.BytesIO("# 标题\n\n**粗体**".encode()), "文档.md")},
        content_type="multipart/form-data",
    )
    assert md.status_code == 200

    exported_json = client.get("/api/export/json")
    manifest = json.loads(exported_json.data)
    assert manifest["format"] == "mynote-backup"
    assert len(manifest["notes"]) == 2

    markdown_export = client.get("/api/export/markdown")
    with zipfile.ZipFile(io.BytesIO(markdown_export.data)) as archive:
        assert len(archive.namelist()) == 2

    backup = client.get("/api/export/backup")
    with zipfile.ZipFile(io.BytesIO(backup.data)) as archive:
        assert "manifest.json" in archive.namelist()

    second = app.test_client()
    register(second, "family", "familypass123", "家人")
    restored = api_request(
        second,
        "POST",
        "/api/import",
        data={"file": (io.BytesIO(backup.data), "backup.zip")},
        content_type="multipart/form-data",
    )
    assert restored.status_code == 200
    assert restored.get_json()["notes"] == 2
    assert len(second.get("/api/notes").get_json()["notes"]) == 2


def test_page_contains_responsive_shell(client):
    page = client.get("/")
    assert page.status_code == 200
    assert b'id="workspace"' in page.data
    assert b'id="boot-screen"' in page.data
    assert b'id="auth-screen" class="auth-screen hidden"' in page.data
    assert b'id="note-title-input"' not in page.data
    assert b'class="pin-button-label"' in page.data
    assert b'class="privacy-bar"' not in page.data
    assert "首页".encode() in page.data
    css = client.get("/static/styles.css")
    assert b"max-width: 760px" in css.data
    assert b'data-mobile-view="editor"' in css.data
    assert b"grid-template-columns: 34px minmax(0, 1fr) auto" in css.data
    assert b"touch-action: pan-x" in css.data
    assert b".swipe-delete-button" in css.data
    assert b"touch-action: pan-y" in css.data
    assert b"translateX(-78px)" in css.data
    assert b'[contenteditable="true"] { font-size: 16px !important; }' in css.data

    script = client.get("/static/app.js")
    assert b'state.currentNote = null' in script.data
    assert b'persistLocation();' in script.data
    assert b'function editorIsBlank()' in script.data
    assert b'discard_if_blank: true' in script.data
    assert "内容为空，离开后移除".encode() in script.data
    assert b'async function saveNow(discardEmpty = false)' in script.data
    assert b'await saveNow(true)' in script.data
    assert b'data-swipe-delete' in script.data
    assert b'pointerdown' in script.data
    assert b'pointermove' in script.data
