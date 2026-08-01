from __future__ import annotations

from tests.conftest import api_request, register


def create_note(client, content="<p>正文内容</p>", group_id=None):
    response = api_request(
        client,
        "POST",
        "/api/notes",
        json={"title": "这个旧名称应被忽略", "content_html": content, "group_id": group_id},
    )
    assert response.status_code == 201
    return response.get_json()["note"]


def test_group_note_crud_search_pin_and_trash(client):
    register(client)
    group_response = api_request(client, "POST", "/api/groups", json={"name": "工作"})
    assert group_response.status_code == 201
    group_id = group_response.get_json()["group"]["id"]

    note = create_note(client, "<p>这是搜索关键字：火箭</p>", group_id)
    assert "title" not in note
    assert client.get("/api/notes").get_json()["notes"] == []
    updated = api_request(
        client,
        "PATCH",
        f"/api/notes/{note['id']}",
        json={"version": note["version"], "title": "仍应忽略", "content_html": "<h2>火箭计划</h2>", "is_pinned": True},
    )
    assert updated.status_code == 200
    assert updated.get_json()["note"]["is_pinned"] is True

    search = client.get(f"/api/notes?group_id={group_id}&q=%E7%81%AB%E7%AE%AD").get_json()["notes"]
    assert [item["id"] for item in search] == [note["id"]]
    grouped = client.get(f"/api/notes?group_id={group_id}").get_json()["notes"]
    assert len(grouped) == 1

    assert api_request(client, "DELETE", f"/api/notes/{note['id']}").status_code == 200
    assert client.get("/api/notes").get_json()["notes"] == []
    assert len(client.get("/api/notes?trash=1").get_json()["notes"]) == 1
    assert api_request(client, "POST", f"/api/notes/{note['id']}/restore").status_code == 200
    assert len(client.get(f"/api/notes?group_id={group_id}").get_json()["notes"]) == 1

    assert api_request(client, "DELETE", f"/api/notes/{note['id']}").status_code == 200
    assert api_request(client, "DELETE", f"/api/notes/{note['id']}/permanent").status_code == 200
    assert client.get("/api/notes?trash=1").get_json()["notes"] == []


def test_html_is_sanitized(client):
    register(client)
    note = create_note(
        client,
        content='<script>alert(1)</script><p onclick="bad()">安全内容</p><a href="javascript:bad()">链接</a>',
    )
    detail = client.get(f"/api/notes/{note['id']}").get_json()["note"]
    assert "<script" not in detail["content_html"]
    assert "onclick" not in detail["content_html"]
    assert "javascript:" not in detail["content_html"]
    assert "安全内容" in detail["content_html"]


def test_stale_version_returns_conflict(client):
    register(client)
    note = create_note(client)
    first = api_request(
        client,
        "PATCH",
        f"/api/notes/{note['id']}",
        json={"version": note["version"], "content_html": "<p>电脑端修改</p>"},
    )
    assert first.status_code == 200
    conflict = api_request(
        client,
        "PATCH",
        f"/api/notes/{note['id']}",
        json={"version": note["version"], "content_html": "<p>手机端旧修改</p>"},
    )
    assert conflict.status_code == 409
    assert conflict.get_json()["code"] == "edit_conflict"
    assert conflict.get_json()["current"]["preview"] == "电脑端修改"


def test_empty_note_is_discarded_without_blank_trash_item(client):
    register(client)
    note = create_note(client, "<p><br></p>")

    discarded = api_request(
        client,
        "DELETE",
        f"/api/notes/{note['id']}",
        json={"version": note["version"], "discard_if_blank": True},
    )

    assert discarded.status_code == 200
    assert discarded.get_json()["discarded"] is True
    assert client.get("/api/notes").get_json()["notes"] == []
    assert client.get("/api/notes?trash=1").get_json()["notes"] == []


def test_cleared_existing_note_is_recoverable_and_version_checked(client):
    register(client)
    note = create_note(client, "<p>删除前的内容</p>")
    updated = api_request(
        client,
        "PATCH",
        f"/api/notes/{note['id']}",
        json={"version": note["version"], "content_html": "<p>另一台设备的新内容</p>"},
    ).get_json()["note"]

    conflict = api_request(
        client,
        "DELETE",
        f"/api/notes/{note['id']}",
        json={"version": note["version"], "discard_if_blank": True},
    )
    assert conflict.status_code == 409
    assert conflict.get_json()["code"] == "edit_conflict"

    removed = api_request(
        client,
        "DELETE",
        f"/api/notes/{note['id']}",
        json={"version": updated["version"], "discard_if_blank": True},
    )
    assert removed.status_code == 200
    assert removed.get_json()["discarded"] is False
    trash = client.get("/api/notes?trash=1").get_json()["notes"]
    assert trash[0]["preview"] == "另一台设备的新内容"


def test_account_data_isolation(app, client):
    register(client, "owner", "password123", "主人")
    private_note = create_note(client, "<p>私密内容</p>")

    other = app.test_client()
    register(other, "family", "familypass123", "家人")
    assert other.get("/api/notes").get_json()["notes"] == []
    assert other.get(f"/api/notes/{private_note['id']}").status_code == 404
    assert api_request(other, "DELETE", f"/api/notes/{private_note['id']}").status_code == 404


def test_deleting_group_moves_notes_to_ungrouped(client):
    register(client)
    group = api_request(client, "POST", "/api/groups", json={"name": "临时"}).get_json()["group"]
    note = create_note(client, group_id=group["id"])
    assert api_request(client, "DELETE", f"/api/groups/{group['id']}").status_code == 200
    detail = client.get(f"/api/notes/{note['id']}").get_json()["note"]
    assert detail["group_id"] is None
    assert [item["id"] for item in client.get("/api/notes").get_json()["notes"]] == [note["id"]]


def test_home_is_default_group_not_all_notes(client):
    register(client)
    home_note = create_note(client, "<p>首页内容</p>")
    group = api_request(client, "POST", "/api/groups", json={"name": "工作"}).get_json()["group"]
    grouped_note = create_note(client, "<p>工作内容</p>", group_id=group["id"])

    home_ids = [item["id"] for item in client.get("/api/notes").get_json()["notes"]]
    grouped_ids = [item["id"] for item in client.get(f"/api/notes?group_id={group['id']}").get_json()["notes"]]
    assert home_ids == [home_note["id"]]
    assert grouped_ids == [grouped_note["id"]]
