// Run with: node --test tests/test_sync_frontend.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8')
  .replace(/bindEvents\(\);\s*bindSecurityEvents\(\);\s*bootstrap\(\);\s*$/, '');

function setup() {
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      content: '', innerHTML: '', textContent: '', value: '', scrollTop: 0, open: false,
      classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
      setAttribute() {}, querySelector: node, querySelectorAll: () => [],
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return nodes.get(selector);
  }
  const ctx = vm.createContext({
    URLSearchParams, AbortController, console, FormData, setTimeout: () => 1, clearTimeout() {},
    document: { querySelector: s => s === 'dialog[open]' ? null : node(s), visibilityState: 'visible' },
  });
  vm.runInContext(source, ctx);
  vm.runInContext(`
    renderGroups = () => {}; renderNotes = () => {}; renderGroupSelect = () => {};
    persistLocation = () => {}; toast = () => {}; mobileView = () => {};
    state.user = {id: 1};
    state.currentNote = {id: 10, version: 1, group_id: null, is_deleted: false,
      is_pinned: false, content_html: '<p>old</p>'};
    els.content.innerHTML = '<p>old</p>'; els.content.textContent = 'old';
    globalThis.stateRef = state; globalThis.syncRef = syncState; globalThis.elsRef = els;
  `, ctx);
  const note = { id: 10, version: 2, group_id: null, is_deleted: false, is_pinned: false, content_html: '<p>remote</p>' };
  const calls = [];
  ctx.api = async url => {
    calls.push(url);
    if (url === '/api/sync') return { user_id: 1, revision: 2 };
    if (url === '/api/groups') return { groups: [] };
    if (url.startsWith('/api/notes?')) return { notes: [note] };
    return { note };
  };
  return { ctx, state: ctx.stateRef, sync: ctx.syncRef, els: ctx.elsRef, note, calls };
}

test('remote saved content updates a clean editor and an unchanged revision only checks the marker', async () => {
  const t = setup();
  await t.ctx.checkSync();
  assert.equal(t.els.content.innerHTML, '<p>remote</p>');
  assert.equal(t.sync.revision, 2);
  t.calls.length = 0;
  await t.ctx.checkSync();
  assert.deepEqual(t.calls, ['/api/sync']);
});

test('unsaved content is preserved as a conflict, including a cleared editor', async () => {
  for (const draft of ['local typing', '']) {
    const t = setup();
    t.state.dirty = true;
    t.els.content.innerHTML = draft;
    await t.ctx.checkSync();
    assert.equal(t.els.content.innerHTML, draft);
    assert.equal(t.state.localConflictDraft.content_html, draft);
    assert.equal(t.els.conflict.open, true);
    assert.equal(t.sync.revision, null);
  }
});

test('typing or navigation during an outstanding sync discards its response', async () => {
  for (const change of [t => { t.state.editRevision++; t.els.content.innerHTML = 'typing'; },
    t => { t.state.currentGroup = 'trash'; }, t => { t.state.sessionEpoch++; }]) {
    const t = setup();
    const api = t.ctx.api;
    t.ctx.api = async url => { const result = await api(url); if (url.startsWith('/api/notes?')) change(t); return result; };
    await t.ctx.checkSync();
    assert.notEqual(t.els.content.innerHTML, '<p>remote</p>');
    assert.equal(t.sync.revision, null);
  }
});

test('composition, hidden pages, and active saves defer polling', async () => {
  for (const block of [t => { t.state.composing = true; }, t => { t.sync.writes = 1; },
    t => { t.ctx.document.visibilityState = 'hidden'; }, t => { t.state.savePromise = Promise.resolve(); }]) {
    const t = setup(); block(t);
    await t.ctx.checkSync();
    assert.equal(t.calls.length, 0);
  }
});

test('a deleted group falls back to home and a permanently deleted clean note closes', async () => {
  const t = setup();
  t.state.currentGroup = 42;
  const api = t.ctx.api;
  t.ctx.api = url => url === '/api/notes/10' ? Promise.reject({ status: 404 }) : api(url);
  await t.ctx.checkSync();
  assert.equal(t.state.currentGroup, 'home');
  assert.equal(t.state.currentNote, null);
  assert.equal(t.els.content.innerHTML, '');
});

test('a failed sync retries without advancing the marker', async () => {
  const t = setup();
  const api = t.ctx.api;
  t.ctx.api = async () => { throw Error('offline'); };
  await t.ctx.checkSync();
  assert.equal(t.sync.revision, null);
  t.ctx.api = api;
  await t.ctx.checkSync();
  assert.equal(t.els.content.innerHTML, '<p>remote</p>');
});

test('typing during save stays dirty and the next save uses the returned version', async () => {
  const t = setup();
  t.state.dirty = true;
  let finish;
  t.ctx.api = () => new Promise(resolve => { finish = resolve; });
  const pending = t.ctx.saveNow();
  t.els.content.innerHTML = 'newer local';
  t.state.editRevision++;
  finish({ note: t.note });
  await pending;
  assert.equal(t.state.dirty, true);
  assert.equal(t.els.content.innerHTML, 'newer local');
  t.ctx.api = async (url, options) => {
    assert.equal(options.body.version, 2);
    assert.equal(options.body.content_html, 'newer local');
    return { note: { ...t.note, version: 3 } };
  };
  await t.ctx.saveNow();
  assert.equal(t.state.dirty, false);
});

test('save conflict keeps the newest local input and blocks navigation', async () => {
  const t = setup();
  t.state.dirty = true;
  let reject;
  t.ctx.api = () => new Promise((resolve, fail) => { reject = fail; });
  const pending = t.ctx.saveNow();
  t.els.content.innerHTML = 'latest local';
  t.state.editRevision++;
  reject({code: 'edit_conflict', data: {current: t.note}});
  await pending;
  assert.equal(t.state.localConflictDraft.content_html, 'latest local');
  assert.equal(await t.ctx.flushSave(), false);
});

test('a server mutation during snapshot collection is retried', async () => {
  const t = setup();
  const api = t.ctx.api;
  let markers = 0;
  t.ctx.api = async url => url === '/api/sync'
    ? { user_id: 1, revision: ++markers } : api(url);
  await t.ctx.checkSync();
  assert.equal(t.sync.revision, null);
  assert.equal(t.els.content.innerHTML, '<p>old</p>');
});

test('typing while a cleared note is being removed preserves the new draft', async () => {
  const t = setup();
  t.els.content.textContent = '';
  t.els.content.innerHTML = '';
  t.els.content.querySelector = () => null;
  let finish;
  t.ctx.api = () => new Promise(resolve => { finish = resolve; });
  const pending = t.ctx.saveNow(true);
  t.els.content.innerHTML = 'new input';
  t.state.dirty = true;
  t.state.editRevision++;
  finish({ok: true});
  await pending;
  assert.equal(t.els.content.innerHTML, 'new input');
  assert.equal(t.state.localConflictDraft.content_html, 'new input');
});

test('remote deletion while dirty offers recovery instead of clearing local text', async () => {
  const t = setup();
  t.state.dirty = true;
  t.els.content.innerHTML = 'keep me';
  const api = t.ctx.api;
  t.ctx.api = url => url === '/api/notes/10' ? Promise.reject({status: 404}) : api(url);
  await t.ctx.checkSync();
  assert.equal(t.state.localConflictDraft.content_html, 'keep me');
  assert.equal(t.state.conflictServer, null);
});
