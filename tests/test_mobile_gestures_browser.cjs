// Requires Playwright and Microsoft Edge: node --test tests/test_mobile_gestures_browser.cjs
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8')
  .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const script = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8')
  .replace(/bindEvents\(\);\s*bindSecurityEvents\(\);\s*bootstrap\(\);\s*$/, '');
let browser;
let contexts = [];
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
afterEach(async () => {
  for (const context of contexts) await context.close();
  contexts = [];
});
after(async () => { await browser?.close(); });

async function setup(view = 'list', width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://mynote.test/');
  await page.addStyleTag({ path: path.join(root, 'static/styles.css') });
  await page.addScriptTag({ content: script });
  await page.evaluate(view => {
    state.user = { id: 1 };
    state.notes = [{ id: 1, preview: '手势测试', content_html: '<p>保存这段内容</p>', version: 1, updated_at: '2026-09-17T08:00:00Z' }];
    state.currentNote = view === 'editor' ? { ...state.notes[0] } : null;
    els.content.innerHTML = state.notes[0].content_html;
    els.groupSelect.innerHTML = '<option value="">首页</option>';
    els.boot.classList.add('hidden');
    els.auth.classList.add('hidden');
    els.app.classList.remove('hidden');
    els.editorEmpty.classList.toggle('hidden', view === 'editor');
    els.editorShell.classList.toggle('hidden', view !== 'editor');
    els.workspace.dataset.mobileView = view;
    window.saves = [];
    window.selections = [];
    window.failSave = false;
    api = async (url, options = {}) => {
      if (url === '/api/notes/1' && options.method === 'PATCH') {
        window.saves.push(options.body);
        if (window.failSave) throw new Error('测试保存失败');
        return { note: { ...state.notes[0], ...options.body, version: 2 } };
      }
      if (url === '/api/notes/1' && options.method === 'DELETE') return {};
      if (url === '/api/groups') return { groups: [] };
      throw new Error(`Unexpected API call: ${url}`);
    };
    selectNote = id => window.selections.push(id);
    selectView = id => window.selections.push(id);
    renderNotes();
    bindEvents();
    window.gestureTrace = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
      document.addEventListener(type, event => window.gestureTrace.push({ type, target: event.target.className, x: event.clientX, y: event.clientY }), true);
    }
  }, view);
  const cdp = await context.newCDPSession(page);
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y], id) => ({ x, y, id })),
  });
  async function swipe(x, y, dx, dy = 0, end = 'touchEnd') {
    await send('touchStart', [[x, y]]);
    for (let step = 1; step <= 6; step++) {
      await send('touchMove', [[x + dx * step / 6, y + dy * step / 6]]);
    }
    await send(end, []);
  }
  const currentView = () => page.locator('#workspace').getAttribute('data-mobile-view');
  async function expectView(expected) {
    try {
      await page.waitForFunction(expected => document.querySelector('#workspace').dataset.mobileView === expected, expected, { timeout: 2000 });
    } catch (error) {
      throw new Error(JSON.stringify(await page.evaluate(() => ({ view: els.workspace.dataset.mobileView, trace: window.gestureTrace, saves: window.saves }))), { cause: error });
    }
    assert.deepEqual(errors, []);
  }
  return { page, send, swipe, currentView, expectView, errors };
}

test('right swipe on a note opens navigation, left swipe on a group closes it without clicking', async () => {
  const { page, swipe, expectView } = await setup();
  const card = await page.locator('.note-card').boundingBox();
  await swipe(90, card.y + 30, 150);
  await expectView('sidebar');
  assert.deepEqual(await page.evaluate(() => window.selections), []);
  const group = await page.locator('[data-view="home"]').boundingBox();
  await swipe(260, group.y + 18, -150);
  await expectView('list');
  assert.deepEqual(await page.evaluate(() => window.selections), []);
});

test('return gesture saves the edited note before clearing it and updating the URL', async () => {
  for (const fromMargin of [false, true]) {
    const { page, swipe, expectView } = await setup('editor');
    await page.evaluate(() => {
      state.dirty = true;
      history.replaceState({}, '', '/#group=home&note=1');
    });
    if (fromMargin) await swipe(14, 210, 150);
    else await swipe(70, 28, 150);
    await expectView('list');
    assert.equal(await page.evaluate(() => state.currentNote), null);
    assert.equal(await page.evaluate(() => window.saves[0].content_html), '<p>保存这段内容</p>');
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).has('note'), false);
  }
});

test('failed saves, conflicts and composition keep the editor and draft intact', async () => {
  for (const reason of ['failure', 'conflict', 'composition']) {
    const { page, swipe, currentView } = await setup('editor');
    await page.evaluate(reason => {
      state.dirty = true;
      window.failSave = reason === 'failure';
      state.localConflictDraft = reason === 'conflict' ? { content_html: '本地草稿' } : null;
      state.composing = reason === 'composition';
    }, reason);
    await swipe(70, 28, 150);
    assert.equal(await currentView(), 'editor', reason);
    assert.equal(await page.locator('#note-content').innerHTML(), '<p>保存这段内容</p>');
    assert.equal(await page.evaluate(() => state.currentNote.id), 1);
  }
});

test('left swipe still reveals delete and right swipe closes it before opening navigation', async () => {
  const { page, swipe, currentView, expectView } = await setup();
  const card = await page.locator('.note-card').boundingBox();
  await swipe(260, card.y + 30, -150);
  assert.equal(await page.locator('.note-swipe-row.swiped').count(), 1);
  assert.equal(await currentView(), 'list');
  await swipe(70, card.y + 30, 150);
  assert.equal(await page.locator('.note-swipe-row.swiped').count(), 0);
  assert.equal(await currentView(), 'list');
  await swipe(70, card.y + 30, 150);
  await expectView('sidebar');
});

test('short, vertical, diagonal, reversed and cancelled swipes do not navigate', async () => {
  for (const [dx, dy, end] of [[40, 0], [8, 130], [100, 130], [-120, 0], [140, 0, 'touchCancel']]) {
    const { swipe, currentView } = await setup();
    await swipe(160, 360, dx, dy, end);
    assert.equal(await currentView(), 'list', `${dx}, ${dy}, ${end}`);
  }
});

test('editable content, toolbar and search fields keep their touch interactions', async () => {
  const { page, swipe, currentView } = await setup('editor');
  await swipe(70, 220, 160);
  assert.equal(await currentView(), 'editor');
  const toolbar = await page.locator('#toolbar').boundingBox();
  await swipe(270, toolbar.y + 20, -180);
  assert.equal(await currentView(), 'editor');
  assert.ok(await page.locator('#toolbar').evaluate(el => el.scrollLeft > 0));
  const list = await setup();
  const search = await list.page.locator('#search-input').boundingBox();
  await list.swipe(search.x + 30, search.y + 15, 150);
  assert.equal(await list.currentView(), 'list');
});

test('two fingers, desktop widths, open dialogs and mouse drags do not navigate', async () => {
  const mobile = await setup();
  await mobile.send('touchStart', [[70, 350]]);
  await mobile.send('touchStart', [[70, 350], [160, 350]]);
  await mobile.send('touchMove', [[180, 350], [270, 350]]);
  await mobile.send('touchEnd', []);
  assert.equal(await mobile.currentView(), 'list');
  await mobile.page.mouse.move(70, 350);
  await mobile.page.mouse.down();
  await mobile.page.mouse.move(220, 350, { steps: 6 });
  await mobile.page.mouse.up();
  assert.equal(await mobile.currentView(), 'list');
  await mobile.page.evaluate(() => els.confirmDialog.showModal());
  await mobile.swipe(70, 350, 150);
  assert.equal(await mobile.currentView(), 'list');
  const desktop = await setup('list', 1200);
  // Test the app's breakpoint guard without invoking the desktop browser's own history swipe.
  for (const [type, x] of [['pointerdown', 260], ['pointermove', 290], ['pointermove', 410], ['pointerup', 410]]) {
    await desktop.page.locator('.note-list-pane').dispatchEvent(type, {
      pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: 350, bubbles: true,
    });
  }
  assert.equal(await desktop.currentView(), 'list');
});

test('vertical touch scrolling stays available in long note lists and editor documents', async () => {
  const list = await setup();
  await list.page.evaluate(() => {
    state.notes = Array.from({ length: 30 }, (_, i) => ({ ...state.notes[0], id: i + 1 }));
    renderNotes();
  });
  await list.swipe(170, 600, 4, -240);
  assert.equal(await list.currentView(), 'list');
  assert.ok(await list.page.locator('#note-list').evaluate(el => el.scrollTop > 0));
  const editor = await setup('editor');
  await editor.page.locator('#note-content').evaluate(el => { el.innerHTML = '<p>上下滚动内容</p>'.repeat(70); });
  await editor.swipe(170, 600, 4, -240);
  assert.equal(await editor.currentView(), 'editor');
  assert.ok(await editor.page.locator('.editor-document').evaluate(el => el.scrollTop > 0));
});

test('empty lists and trash support navigation, and returning from a blank note still removes it', async () => {
  for (const group of ['home', 'trash']) {
    const app = await setup();
    await app.page.evaluate(group => { state.currentGroup = group; state.notes = []; renderNotes(); }, group);
    await app.swipe(70, 350, 150);
    await app.expectView('sidebar');
  }
  const editor = await setup('editor');
  await editor.page.evaluate(() => { els.content.innerHTML = ''; state.dirty = true; });
  await editor.swipe(70, 28, 150);
  await editor.expectView('list');
  assert.equal(await editor.page.evaluate(() => state.currentNote), null);
  assert.equal(await editor.page.locator('.note-card').count(), 0);
});
