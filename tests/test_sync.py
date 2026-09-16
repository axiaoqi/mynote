import io
import sqlite3

from mynote import create_app
from tests.conftest import api_request, register
from tests.test_notes import create_note
from mynote.db import get_db, init_app_database


def revision(client):
    response = client.get('/api/sync')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-store'
    return response.get_json()['revision']


def test_sync_tracks_note_and_group_lifecycle(client):
    register(client)
    previous = revision(client)

    def changed():
        nonlocal previous
        current = revision(client)
        assert current > previous
        previous = current

    group = api_request(client, 'POST', '/api/groups', json={'name': '工作'}).get_json()['group']
    changed()
    note = create_note(client, group_id=group['id'])
    changed()
    api_request(client, 'PATCH', f"/api/notes/{note['id']}", json={'version': 1, 'content_html': '<p>修改</p>'})
    changed()
    api_request(client, 'PATCH', f"/api/groups/{group['id']}", json={'name': '改名'})
    changed()
    api_request(client, 'DELETE', f"/api/groups/{group['id']}")
    changed()
    assert client.get(f"/api/notes/{note['id']}").get_json()['note']['group_id'] is None
    api_request(client, 'DELETE', f"/api/notes/{note['id']}")
    changed()
    api_request(client, 'POST', f"/api/notes/{note['id']}/restore")
    changed()
    api_request(client, 'DELETE', f"/api/notes/{note['id']}")
    changed()
    api_request(client, 'DELETE', f"/api/notes/{note['id']}/permanent")
    changed()
    assert revision(client) == previous


def test_sync_is_private_and_transactional(app, client):
    assert client.get('/api/sync').status_code == 401
    register(client)
    other = app.test_client()
    register(other, username='other')
    other_revision = revision(other)
    note = create_note(client)
    assert revision(other) == other_revision
    previous = revision(client)
    with app.app_context():
        db = get_db()
        db.execute('UPDATE notes SET content_html = ? WHERE id = ?', ('rollback', note['id']))
        db.rollback()
    assert revision(client) == previous
    api_request(client, 'PATCH', f"/api/notes/{note['id']}", json={'version': 999, 'content_html': 'stale'})
    assert revision(client) == previous


def test_sync_triggers_survive_reinitialization_and_bulk_import(app, client):
    register(client)
    previous = revision(client)
    with app.app_context():
        init_app_database()
        init_app_database()
    assert revision(client) == previous
    create_note(client)
    assert revision(client) == previous + 1
    response = api_request(client, 'POST', '/api/import', data={
        'file': (io.BytesIO('导入内容'.encode()), 'note.txt'),
    })
    assert response.status_code == 200
    assert revision(client) > previous + 1


def test_sync_upgrades_existing_database(tmp_path):
    instance = tmp_path / 'legacy'
    instance.mkdir()
    db = sqlite3.connect(instance / 'mynote.sqlite3')
    db.execute('''CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT,
        password_hash TEXT, is_admin INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT '')''')
    db.execute("INSERT INTO users(username, display_name, password_hash) VALUES ('old', '原用户', 'unused')")
    db.commit()
    db.close()
    app = create_app({'TESTING': True, 'INSTANCE_PATH': str(instance), 'SECRET_KEY': 'test'})
    with app.app_context():
        db = get_db()
        assert db.execute('SELECT sync_revision FROM users WHERE id = 1').fetchone()[0] == 0
        db.execute("INSERT INTO notes(user_id, content_html) VALUES (1, '升级后的便签')")
        db.commit()
        assert db.execute('SELECT sync_revision FROM users WHERE id = 1').fetchone()[0] == 1
