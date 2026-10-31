from __future__ import annotations

import io
import json
from pathlib import Path

import pyzipper
import pytest

from mynote.backups import backup_tick, next_run, backup_directory
from mynote.db import get_db
from tests.conftest import api_request, register
from tests.test_files_and_exports import PNG_1X1
from tests.test_notes import create_note

ENTRY = {'title': '邮箱', 'username': 'alice', 'password': 'private-password', 'url': 'https://example.com', 'notes': '<script>example</script>'}


def setup_vault(client):
    response = api_request(client, 'POST', '/api/vault/password', json={
        'current_password': 'password123', 'new_password': 'vault-pass123', 'confirm_password': 'vault-pass123',
    })
    assert response.status_code == 200, response.get_json()


def add_entry(client):
    response = api_request(client, 'POST', '/api/notes?space=private', json={'content_html': '<p>邮箱</p><p>账号：alice</p><p>密码：private-password</p>'})
    assert response.status_code == 201
    return response.get_json()['note']


def configure(client, **overrides):
    data = dict(enabled=True, interval_days=1, time_of_day='03:00', retention_days=30, password='zip-password123', current_password='zip-password123')
    data.update(overrides)
    return api_request(client, 'PUT', '/api/backups', json=data)


def test_private_notes_crud_isolation_and_csrf(app, client):
    register(client)
    assert client.post('/api/vault/unlock', json={}).status_code == 403
    assert client.get('/api/notes?space=private&q=邮箱').status_code == 423
    setup_vault(client)
    entry = add_entry(client)
    with app.app_context():
        assert get_db().execute('SELECT is_private FROM notes').fetchone()[0] == 1
    assert len(client.get('/api/notes?q=邮箱').get_json()['notes']) == 1
    other = app.test_client()
    register(other, 'family')
    setup_vault(other)
    assert other.get('/api/notes?space=private&q=邮箱').get_json()['notes'] == []
    assert api_request(other, 'DELETE', f"/api/notes/{entry['id']}").status_code == 404
    assert api_request(client, 'PATCH', f"/api/notes/{entry['id']}", json={'version': entry['version'], 'content_html': '<p>邮箱修改</p>'}).status_code == 200
    assert client.get('/api/notes?space=private&q=邮箱').get_json()['notes'][0]['preview'] == '邮箱修改'
    assert api_request(client, 'DELETE', f"/api/notes/{entry['id']}").status_code == 200
    assert client.get('/api/notes?space=private&q=邮箱').get_json()['notes'] == []


def test_idle_timeout_is_server_enforced_reads_do_not_extend_and_replay_fails(app, client, monkeypatch):
    clock = [100000]
    monkeypatch.setattr('mynote.vault.now', lambda: clock[0])
    register(client)
    setup_vault(client)
    add_entry(client)
    clock[0] += 299
    assert client.get('/api/notes?space=private&q=邮箱').status_code == 200
    clock[0] += 1
    assert client.get('/api/notes?space=private&q=邮箱').status_code == 423
    assert api_request(client, 'POST', '/api/vault/touch').status_code == 423
    assert api_request(client, 'POST', '/api/notes?space=private&q=邮箱', json=ENTRY).status_code == 423
    assert client.get('/api/export/json').status_code == 423
    assert client.get('/api/export/backup').status_code == 423
    assert api_request(client, 'POST', '/api/vault/unlock', json={'password': 'vault-pass123'}).status_code == 200
    clock[0] += 200
    assert api_request(client, 'POST', '/api/vault/touch').status_code == 200
    clock[0] += 200
    assert client.get('/api/notes?space=private&q=邮箱').status_code == 200
    with client.session_transaction() as session:
        old_token = session['vault_token']
    assert api_request(client, 'POST', '/api/vault/lock').status_code == 200
    with client.session_transaction() as session:
        session['vault_token'] = old_token
    assert client.get('/api/notes?space=private&q=邮箱').status_code == 423


def test_vault_unlock_rate_limit_and_password_change_revokes_grants(app, client):
    register(client)
    setup_vault(client)
    other = app.test_client()
    api_request(other, 'POST', '/api/login', json={'username': 'owner', 'password': 'password123'})
    assert api_request(other, 'POST', '/api/vault/unlock', json={'password': 'vault-pass123'}).status_code == 200
    response = api_request(client, 'POST', '/api/vault/password', json={'password': 'vault-pass123', 'new_password': 'changed-vault123', 'confirm_password': 'changed-vault123'})
    assert response.status_code == 200
    assert other.get('/api/notes?space=private&q=邮箱').status_code == 423
    for _ in range(4):
        assert api_request(other, 'POST', '/api/vault/unlock', json={'password': 'wrong'}).status_code == 400
    assert api_request(other, 'POST', '/api/vault/unlock', json={'password': 'wrong'}).status_code == 429


def test_encrypted_zip_includes_json_markdown_images_and_vault_and_restores(app, client):
    register(client)
    setup_vault(client)
    add_entry(client)
    note = create_note(client, '<p>备份正文</p>')
    uploaded = api_request(client, 'POST', f"/api/notes/{note['id']}/attachments", data={'file': (io.BytesIO(PNG_1X1), 'pixel.png')})
    assert uploaded.status_code == 201
    attachment = uploaded.get_json()['attachment']
    assert api_request(client, 'PATCH', f"/api/notes/{note['id']}", json={'version': note['version'], 'content_html': f'<p>备份正文</p><img src="{attachment["url"]}">'}).status_code == 200
    assert client.get('/api/export/backup').status_code == 400
    response = api_request(client, 'POST', '/api/export/backup', json={'password': 'zip-password123'})
    assert response.status_code == 200
    with pyzipper.AESZipFile(io.BytesIO(response.data)) as archive:
        assert all(item.flag_bits & 1 for item in archive.infolist())
        with pytest.raises(RuntimeError):
            archive.read('manifest.json')
        archive.setpassword(b'wrong')
        with pytest.raises(RuntimeError):
            archive.read('manifest.json')
        archive.setpassword(b'zip-password123')
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['notes'][0]['content_html'].find(ENTRY['password']) >= 0
        assert any('备份正文' in archive.read(name).decode() for name in archive.namelist() if name.startswith('markdown/') and name.endswith('.md'))
        assert any(ENTRY['password'] in archive.read(name).decode() for name in archive.namelist() if name.startswith('markdown/账号密码/'))
        assert any(name.startswith('attachments/') for name in archive.namelist())
    second = app.test_client()
    register(second, 'restore')
    bad = api_request(second, 'POST', '/api/import', data={'file': (io.BytesIO(response.data), 'backup.zip'), 'password': 'wrong'})
    assert bad.get_json()['code'] == 'zip_password_required'
    assert second.get('/api/notes').get_json()['notes'] == []
    locked = api_request(second, 'POST', '/api/import', data={'file': (io.BytesIO(response.data), 'backup.zip'), 'password': 'zip-password123'})
    assert locked.status_code == 423
    setup_vault(second)
    restored = api_request(second, 'POST', '/api/import', data={'file': (io.BytesIO(response.data), 'backup.zip'), 'password': 'zip-password123'})
    assert restored.status_code == 200, restored.get_json()
    assert restored.get_json()['vault_entries'] == 1
    assert ENTRY['password'] in second.get('/api/notes?space=private&q=邮箱').get_json()['notes'][0]['preview']
    assert client.get('/api/export/json').get_json()['notes'][0]['content_html'].find(ENTRY['password']) >= 0


def test_automatic_backup_works_while_vault_locked_and_retention_is_configurable(app, client, monkeypatch):
    register(client)
    setup_vault(client)
    add_entry(client)
    assert configure(client, retention_days=7, interval_days=2).status_code == 200
    api_request(client, 'POST', '/api/vault/lock')
    assert configure(client, password='attacker-password').status_code == 423
    with app.app_context():
        db = get_db()
        config = db.execute('SELECT * FROM backup_settings').fetchone()
        assert 'zip-password123' not in config['password']
        db.execute('UPDATE backup_settings SET next_run = 1')
        db.commit()
        backup_tick()
        file = db.execute('SELECT * FROM backup_files').fetchone()
        assert file
        path = backup_directory(file['user_id']) / file['filename']
        with pyzipper.AESZipFile(str(path)) as archive:
            archive.setpassword(b'zip-password123')
            assert json.loads(archive.read('manifest.json'))['notes'][0]['content_html'].find(ENTRY['password']) >= 0
        assert not list(path.parent.glob('*.tmp'))
        backup_tick()
        assert db.execute('SELECT count(*) FROM backup_files').fetchone()[0] == 1
        current_time = file['created_at']
        monkeypatch.setattr('mynote.backups.now', lambda: current_time + 7 * 86400)
        db.execute('UPDATE backup_settings SET enabled = 0')
        db.commit()
        backup_tick()
        assert not path.exists()
        assert db.execute('SELECT count(*) FROM backup_files').fetchone()[0] == 0
    status = client.get('/api/backups').get_json()
    assert status['config']['retention_days'] == 7
    assert 'password' not in status['config']


def test_backup_validation_failure_status_and_owner_only_download(app, client, monkeypatch):
    register(client)
    assert configure(client, retention_days=31).status_code == 400
    assert configure(client, retention_days=0).status_code == 400
    assert configure(client, time_of_day='25:00').status_code == 400
    assert configure(client).status_code == 200
    assert api_request(client, 'POST', '/api/backups/run').status_code == 200
    file_id = client.get('/api/backups').get_json()['files'][0]['id']
    assert client.get(f'/api/backups/{file_id}').status_code == 200
    other = app.test_client()
    register(other, 'other')
    assert other.get(f'/api/backups/{file_id}').status_code == 404
    monkeypatch.setattr('mynote.backups.build_backup', lambda *args: (_ for _ in ()).throw(OSError('disk full')))
    assert api_request(client, 'POST', '/api/backups/run').status_code == 503
    status = client.get('/api/backups').get_json()
    assert len(status['files']) == 1
    assert status['config']['last_error']


def test_schedule_uses_beijing_time():
    from datetime import datetime, timezone
    before = int(datetime(2026, 10, 30, 18, 59, tzinfo=timezone.utc).timestamp())
    assert next_run('03:00', after=before) == before + 60
    assert next_run('03:00', 7, after=before + 60) == before + 60 + 7 * 86400


def test_missing_keys_fail_closed_and_do_not_replace_existing_keys(app, client):
    register(client)
    setup_vault(client)
    add_entry(client)
    assert configure(client).status_code == 200
    with app.app_context():
        backup_key = Path(app.instance_path) / '.backup_key'
        backup_key.unlink()
    assert api_request(client, 'POST', '/api/backups/run').status_code == 503
    assert not backup_key.exists()


def test_shrinking_retention_removes_only_old_backups_and_password_change_affects_new_files(app, client):
    register(client)
    assert configure(client).status_code == 200
    assert api_request(client, 'POST', '/api/backups/run').status_code == 200
    old_file = client.get('/api/backups').get_json()['files'][0]
    assert configure(client, password='new-zip-password').status_code == 200
    assert api_request(client, 'POST', '/api/backups/run').status_code == 200
    files = client.get('/api/backups').get_json()['files']
    assert len(files) == 2
    new_file = next(file for file in files if file['id'] != old_file['id'])
    with pyzipper.AESZipFile(io.BytesIO(client.get(f"/api/backups/{new_file['id']}").data)) as archive:
        archive.setpassword(b'zip-password123')
        with pytest.raises(RuntimeError):
            archive.read('manifest.json')
        archive.setpassword(b'new-zip-password')
        assert json.loads(archive.read('manifest.json'))['format'] == 'mynote-backup'
    with pyzipper.AESZipFile(io.BytesIO(client.get(f"/api/backups/{old_file['id']}").data)) as archive:
        archive.setpassword(b'zip-password123')
        assert json.loads(archive.read('manifest.json'))['format'] == 'mynote-backup'
    with app.app_context():
        db = get_db()
        db.execute('UPDATE backup_files SET created_at = created_at - ? WHERE id = ?', (8 * 86400, old_file['id']))
        db.commit()
    assert configure(client, retention_days=7, password='').status_code == 200
    remaining = client.get('/api/backups').get_json()['files']
    assert len(remaining) == 1
    assert remaining[0]['id'] != old_file['id']


def test_changing_zip_password_requires_correct_previous_password(client):
    register(client)
    assert configure(client).status_code == 200
    assert configure(client, password='new-zip-password', current_password='').status_code == 400
    assert configure(client, password='new-zip-password', current_password='wrong-password').get_json()['code'] == 'backup_password_incorrect'
    # Schedule changes do not require the old ZIP password.
    assert configure(client, password='', current_password='', retention_days=7).status_code == 200
    assert configure(client, password='new-zip-password', current_password='zip-password123').status_code == 200
    assert api_request(client, 'POST', '/api/backups/run').status_code == 200
    file = client.get('/api/backups').get_json()['files'][0]
    with pyzipper.AESZipFile(io.BytesIO(client.get(f"/api/backups/{file['id']}").data)) as archive:
        archive.setpassword(b'new-zip-password')
        assert json.loads(archive.read('manifest.json'))['format'] == 'mynote-backup'
