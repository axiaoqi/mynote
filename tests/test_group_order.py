from tests.conftest import api_request, register
from tests.test_vault_and_backups import setup_vault


def create_groups(client, private=False):
    suffix = '?space=private' if private else ''
    return [api_request(client, 'POST', '/api/groups' + suffix, json={'name': name}).get_json()['group']['id'] for name in ('第一组', '第二组', '第三组')]


def test_group_order_persists_and_isolates_users_and_private_area(app, client):
    register(client)
    normal = create_groups(client)
    before = client.get('/api/sync').get_json()['revision']
    assert api_request(client, 'POST', '/api/groups/reorder', json={'ids': normal[::-1]}).status_code == 200
    assert [group['id'] for group in client.get('/api/groups').get_json()['groups']] == normal[::-1]
    assert client.get('/api/sync').get_json()['revision'] > before
    assert api_request(client, 'POST', '/api/groups/reorder', json={'ids': normal[:2]}).status_code == 409
    assert api_request(client, 'POST', '/api/groups/reorder', json={'ids': [normal[0]] * 3}).status_code == 400
    assert api_request(client, 'POST', '/api/groups/reorder', json={'ids': [True]}).status_code == 400
    other = app.test_client()
    register(other, 'family')
    assert api_request(other, 'POST', '/api/groups/reorder', json={'ids': normal}).status_code == 409
    setup_vault(client)
    private = create_groups(client, private=True)
    assert api_request(client, 'POST', '/api/groups/reorder?space=private', json={'ids': private[1:] + private[:1]}).status_code == 200
    assert [group['id'] for group in client.get('/api/groups?space=private').get_json()['groups']] == private[1:] + private[:1]
    assert api_request(client, 'POST', '/api/groups/reorder', json={'ids': private}).status_code == 409
    assert [group['id'] for group in client.get('/api/groups').get_json()['groups']] == normal[::-1]
    api_request(client, 'POST', '/api/vault/lock')
    assert api_request(client, 'POST', '/api/groups/reorder?space=private', json={'ids': private}).status_code == 423
