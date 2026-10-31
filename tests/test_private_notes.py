from __future__ import annotations

import io
import json
import sqlite3

from mynote import create_app
from mynote.db import SCHEMA, get_db
from tests.conftest import api_request, register
from tests.test_files_and_exports import PNG_1X1
from tests.test_vault_and_backups import setup_vault, add_entry


def test_private_groups_notes_search_trash_and_attachment_gates(app, client):
    register(client)
    setup_vault(client)
    public = api_request(client, 'POST', '/api/groups', json={'name': '网站'}).get_json()['group']
    private = api_request(client, 'POST', '/api/groups?space=private', json={'name': '网站'}).get_json()['group']
    assert public['id'] != private['id']
    assert private['is_private'] is True
    response = api_request(client, 'POST', '/api/notes?space=private', json={'group_id': private['id'], 'content_html': '<h2>秘密网站</h2><p>可正常写便签</p>'})
    assert response.status_code == 201
    note = response.get_json()['note']
    assert client.get('/api/groups').get_json()['groups'] == [public]
    assert len(client.get('/api/notes?q=秘密').get_json()['notes']) == 1
    assert client.get('/api/notes?space=private&q=秘密').get_json()['notes'][0]['id'] == note['id']
    cross = api_request(client, 'PATCH', f"/api/notes/{note['id']}", json={'version': note['version'], 'group_id': public['id']})
    assert cross.status_code == 404
    uploaded = api_request(client, 'POST', f"/api/notes/{note['id']}/attachments", data={'file': (io.BytesIO(PNG_1X1), 'private.png')})
    assert uploaded.status_code == 201
    attachment = uploaded.get_json()['attachment']
    assert client.get(attachment['url']).status_code == 200
    api_request(client, 'POST', '/api/vault/lock')
    for url in ['/api/groups?space=private', '/api/notes?space=private', f"/api/notes/{note['id']}", attachment['url'], '/api/export/json']:
        assert client.get(url).status_code == 423, url
    assert api_request(client, 'PATCH', f"/api/groups/{private['id']}", json={'name': '改名'}).status_code == 423
    assert api_request(client, 'DELETE', f"/api/groups/{private['id']}").status_code == 423
    assert api_request(client, 'DELETE', f"/api/notes/{note['id']}").status_code == 423
    assert api_request(client, 'DELETE', attachment['url']).status_code == 423
    assert client.get('/api/notes?q=秘密').get_json()['notes'] == []
    api_request(client, 'POST', '/api/vault/unlock', json={'password': 'vault-pass123'})
    assert api_request(client, 'DELETE', f"/api/groups/{private['id']}").status_code == 200
    assert client.get(f"/api/notes/{note['id']}").get_json()['note']['group_id'] is None
    assert api_request(client, 'DELETE', f"/api/notes/{note['id']}").status_code == 200
    assert client.get('/api/notes?trash=1').get_json()['notes'] == []
    assert len(client.get('/api/notes?trash=1&space=private').get_json()['notes']) == 1
    assert api_request(client, 'DELETE', '/api/trash').get_json()['deleted'] == 0
    api_request(client, 'POST', '/api/vault/lock')
    assert api_request(client, 'POST', f"/api/notes/{note['id']}/restore").status_code == 423
    assert api_request(client, 'DELETE', f"/api/notes/{note['id']}/permanent").status_code == 423
    assert api_request(client, 'DELETE', '/api/trash?space=private').status_code == 423


def test_old_database_group_migration_preserves_foreign_keys(tmp_path):
    schema = SCHEMA.replace('    is_private INTEGER NOT NULL DEFAULT 0,\n', '').replace(
        'UNIQUE(user_id, is_private, name COLLATE NOCASE)', 'UNIQUE(user_id, name COLLATE NOCASE)')
    instance = tmp_path / 'legacy'
    instance.mkdir()
    db = sqlite3.connect(instance / 'mynote.sqlite3')
    db.executescript(schema)
    db.execute("INSERT INTO users(id, username, display_name, password_hash) VALUES (1, 'legacy', '旧账号', 'unused')")
    db.execute("INSERT INTO note_groups(id, user_id, name) VALUES (7, 1, '原分组')")
    db.execute("INSERT INTO notes(id, user_id, group_id, content_html, plain_text) VALUES (11, 1, 7, '<p>旧正文</p>', '旧正文')")
    db.execute("INSERT INTO attachments(user_id, note_id, stored_name, original_name, mime_type, size) VALUES (1, 11, '1/a.png', 'a.png', 'image/png', 1)")
    db.commit()
    db.close()
    app = create_app({'TESTING': True, 'INSTANCE_PATH': str(instance)})
    with app.app_context():
        db = get_db()
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        assert db.execute('SELECT group_id, is_private FROM notes WHERE id = 11').fetchone()[:] == (7, 0)
        assert db.execute('SELECT count(*) FROM attachments').fetchone()[0] == 1
        db.execute("INSERT INTO note_groups(user_id, name, is_private) VALUES (1, '原分组', 1)")
        db.commit()


def test_old_credential_records_are_migrated_to_private_notes(app, client):
    from mynote.vault import init_vault_database, seal_entry
    register(client)
    setup_vault(client)
    with app.app_context():
        db = get_db()
        db.execute('INSERT INTO vault_entries(user_id, payload) VALUES (?, ?)', (1, seal_entry({'title': '原记录', 'username': 'alice', 'password': 'old-secret', 'url': '', 'notes': ''})))
        db.commit()
        init_vault_database()
        init_vault_database()
        assert db.execute('SELECT count(*) FROM vault_entries').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM notes WHERE is_private = 1').fetchone()[0] == 1
    assert len(client.get('/api/notes?q=old-secret').get_json()['notes']) == 1
    assert 'old-secret' in client.get('/api/notes?space=private&q=old-secret').get_json()['notes'][0]['preview']


def test_ordinary_search_includes_private_notes_only_during_unlock(client, monkeypatch):
    clock = [100000]
    monkeypatch.setattr('mynote.vault.now', lambda: clock[0])
    register(client)
    setup_vault(client)
    private = add_entry(client)
    api_request(client, 'POST', '/api/notes', json={'content_html': '<p>邮箱公开说明</p>'})
    results = client.get('/api/notes?q=邮箱').get_json()
    assert len(results['notes']) == 2
    assert results['vault_expires_at'] == 100300
    assert len(client.get('/api/notes').get_json()['notes']) == 1
    clock[0] += 299
    assert len(client.get('/api/notes?q=邮箱').get_json()['notes']) == 2
    clock[0] += 1
    results = client.get('/api/notes?q=邮箱').get_json()
    assert len(results['notes']) == 1
    assert not results['notes'][0]['is_private']
    assert results['vault_expires_at'] is None
    assert client.get(f"/api/notes/{private['id']}").status_code == 423


def test_old_named_default_becomes_sortable_normal_group_without_losing_notes(app, client):
    from mynote.vault import init_vault_database
    register(client)
    setup_vault(client)
    note = add_entry(client)
    other_group = api_request(client, 'POST', '/api/groups?space=private', json={'name': '另一个分组'}).get_json()['group']
    with app.app_context():
        db = get_db()
        db.execute("UPDATE vault_settings SET default_group_name = '国外账号密码', default_group_migrated = 0 WHERE user_id = 1")
        db.commit()
        init_vault_database()
        init_vault_database()
    groups = client.get('/api/groups?space=private').get_json()['groups']
    assert [group['name'] for group in groups] == ['国外账号密码', '另一个分组']
    migrated = groups[0]
    restored = client.get(f"/api/notes/{note['id']}").get_json()['note']
    assert restored['group_id'] == migrated['id']
    assert 'private-password' in restored['content_html']
    assert api_request(client, 'POST', '/api/groups/reorder?space=private', json={'ids': [other_group['id'], migrated['id']]}).status_code == 200
    assert client.get('/api/groups?space=private').get_json()['groups'][-1]['id'] == migrated['id']
    assert api_request(client, 'PATCH', f"/api/groups/{migrated['id']}", json={'name': '国外账号'}).status_code == 200
    root_note = add_entry(client)
    with app.app_context():
        init_vault_database()
    assert client.get(f"/api/notes/{root_note['id']}").get_json()['note']['group_id'] is None
    assert len(client.get('/api/groups?space=private').get_json()['groups']) == 2
    assert 'private_default_group_name' not in client.get('/api/export/json').get_json()


def test_old_backup_default_name_restores_as_normal_group_without_moving_existing_notes(client):
    register(client)
    setup_vault(client)
    existing = add_entry(client)
    manifest = {'format': 'mynote-backup', 'version': 2, 'private_default_group_name': '国外账号密码',
                'groups': [], 'notes': [{'id': 77, 'is_private': 1, 'group_id': None, 'content_html': '<p>旧备份内容</p>'}]}
    response = api_request(client, 'POST', '/api/import', data={'file': (io.BytesIO(json.dumps(manifest).encode()), 'old.json')})
    assert response.status_code == 200
    groups = client.get('/api/groups?space=private').get_json()['groups']
    assert groups[0]['name'] == '国外账号密码'
    notes = client.get('/api/notes?space=private&group_id=' + str(groups[0]['id'])).get_json()['notes']
    assert notes[0]['preview'] == '旧备份内容'
    assert client.get(f"/api/notes/{existing['id']}").get_json()['note']['group_id'] is None


def test_private_homepage_lists_all_active_private_groups_but_keeps_default_separate(client):
    register(client)
    setup_vault(client)
    default = add_entry(client)
    group = api_request(client, 'POST', '/api/groups?space=private', json={'name': '国外账号密码'}).get_json()['group']
    grouped = api_request(client, 'POST', '/api/notes?space=private', json={'group_id': group['id'], 'content_html': '<p>分组内容</p>'}).get_json()['note']
    api_request(client, 'POST', '/api/notes', json={'content_html': '<p>普通便签</p>'})
    results = client.get('/api/notes?space=private&group_id=all').get_json()['notes']
    assert {note['id'] for note in results} == {default['id'], grouped['id']}
    assert client.get('/api/notes?space=private&group_id=ungrouped').get_json()['notes'][0]['id'] == default['id']
    api_request(client, 'DELETE', f"/api/notes/{grouped['id']}")
    results = client.get('/api/notes?space=private&group_id=all').get_json()['notes']
    assert [note['id'] for note in results] == [default['id']]
    api_request(client, 'POST', '/api/vault/lock')
    assert client.get('/api/notes?space=private&group_id=all').status_code == 423
