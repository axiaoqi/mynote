from pathlib import Path

import pytest

from mynote.backups import backup_directory, directory_name, init_backup_database, prune_backups
from mynote.db import get_db
from tests.conftest import api_request, register
from tests.test_vault_and_backups import configure


@pytest.mark.parametrize(('username', 'expected'), [
    ('小明', '小明_7'),
    ('alice@example.com', 'alice_example_com_7'),
    ('../../a\\b:*?', '______a_b____7'),
    ('Abc_123-中文', 'Abc_123-中文_7'),
    ('a' * 40, 'a' * 24 + '_7'),
    ('', 'user_7'),
    ('CON', 'CON_7'),
])
def test_safe_short_directory_names(username, expected):
    name = directory_name(username, 7)
    assert name == expected
    assert len(name.removesuffix('_7')) <= 24
    assert not any(character in name for character in '/\\.:*?')


def test_legacy_backups_migrate_and_name_remains_stable_after_username_change(app, client):
    register(client)
    assert configure(client).status_code == 200
    assert api_request(client, 'POST', '/api/backups/run').status_code == 200
    file = client.get('/api/backups').get_json()['files'][0]
    original = client.get(f"/api/backups/{file['id']}").data
    with app.app_context():
        folder = backup_directory(1)
        assert folder.name == 'owner_1'
        legacy = folder.parent / '1'
        # Both resolved paths are inside this test's instance/backups directory.
        assert folder.resolve().parent == legacy.resolve().parent
        folder.rename(legacy)
        db = get_db()
        db.execute('DELETE FROM backup_directories')
        db.commit()
        init_backup_database()
        assert not legacy.exists()
        assert (folder / file['filename']).read_bytes() == original
        db.execute("UPDATE users SET username = 'changed-owner' WHERE id = 1")
        db.commit()
        init_backup_database()
        assert backup_directory(1) == folder
    assert client.get('/api/backups').get_json()['config']['directory'] == 'instance/backups/owner_1/'
    assert client.get(f"/api/backups/{file['id']}").data == original
    assert api_request(client, 'POST', '/api/backups/run').status_code == 200
    with app.app_context():
        db = get_db()
        db.execute('UPDATE backup_files SET created_at = created_at - ?', (40 * 86400,))
        db.commit()
        prune_backups(1, 30)
        assert db.execute('SELECT count(*) FROM backup_files').fetchone()[0] == 0
        assert list(folder.glob('*.zip')) == []


def test_interrupted_migration_resumes_without_overwriting_files(app, client):
    register(client)
    with app.app_context():
        target = backup_directory(1)
        target.mkdir(parents=True)
        legacy = target.parent / '1'
        legacy.mkdir()
        (target / 'same.zip').write_bytes(b'same')
        (legacy / 'same.zip').write_bytes(b'same')
        (legacy / 'older.zip').write_bytes(b'old')
        assert backup_directory(1) == target
        assert not legacy.exists()
        assert (target / 'same.zip').read_bytes() == b'same'
        assert (target / 'older.zip').read_bytes() == b'old'
        legacy.mkdir()
        (legacy / 'same.zip').write_bytes(b'different')
        with pytest.raises(OSError, match='同名不同内容'):
            backup_directory(1)
        assert (legacy / 'same.zip').read_bytes() == b'different'
        assert (target / 'same.zip').read_bytes() == b'same'


def test_directory_mapping_cannot_escape_backup_root(app, client):
    register(client)
    with app.app_context():
        db = get_db()
        db.execute('INSERT INTO backup_directories VALUES (?, ?)', (1, '../outside'))
        db.commit()
        with pytest.raises(OSError, match='路径无效'):
            backup_directory(1)
        assert not (Path(app.instance_path) / 'outside').exists()


def test_deleted_backups_are_removed_from_listing_without_affecting_password_or_other_files(app, client):
    register(client)
    configure(client)
    for _ in range(2):
        assert api_request(client, 'POST', '/api/backups/run').status_code == 200
    files = client.get('/api/backups').get_json()['files']
    removed, kept = files
    with app.app_context():
        (backup_directory(1) / removed['filename']).unlink()
    status = client.get('/api/backups').get_json()
    assert [file['id'] for file in status['files']] == [kept['id']]
    assert status['config']['password_set'] is True
    assert status['config']['last_success'] is not None
    assert client.get(f"/api/backups/{removed['id']}").status_code == 404
    assert client.get(f"/api/backups/{kept['id']}").status_code == 200
    with app.app_context():
        assert get_db().execute('SELECT 1 FROM backup_files WHERE id = ?', (removed['id'],)).fetchone() is None
