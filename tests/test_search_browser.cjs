// Requires Playwright and Microsoft Edge: node --test tests/test_search_browser.cjs
const { test } = require('node:test');
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

for (const width of [1280, 390]) {
  test(`global search, result navigation and separate trash at width ${width}`, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('http://mynote.test/');
      await page.addStyleTag({ path: path.join(root, 'static/styles.css') });
      await page.addScriptTag({ content: script });
      await page.evaluate(async () => {
        state.user = { id: 1 };
        const groups = [{ id: 7, name: '工作' }, { id: 8, name: '生活 <计划> 与长分组名称测试' }];
        const notes = [
          { id: 1, group_id: null, preview: '火箭首页', is_deleted: false },
          { id: 2, group_id: 7, preview: '火箭工作', is_deleted: false },
          { id: 3, group_id: 8, preview: '火箭生活', is_deleted: false },
          { id: 4, group_id: 8, preview: '火箭归档', is_deleted: true },
        ].map(note => ({ ...note, version: 1, content_html: `<p>${note.preview}</p>`, updated_at: '2026-09-22T08:00:00Z' }));
        api = async url => {
          if (url === '/api/groups') return { groups };
          if (url.startsWith('/api/notes?')) {
            const params = new URLSearchParams(url.split('?')[1]);
            // Deliberately honor any group filter, catching accidental scoped requests.
            return { notes: notes.filter(note => note.is_deleted === (params.get('trash') === '1')
              && (!params.has('group_id') || String(note.group_id ?? 'ungrouped') === params.get('group_id'))
              && (!params.get('q') || note.preview.includes(params.get('q')))) };
          }
          const match = url.match(/^\/api\/notes\/(\d+)$/);
          if (match) return { note: notes.find(note => note.id === Number(match[1])) };
          throw new Error(`Unexpected API call: ${url}`);
        };
        els.boot.classList.add('hidden');
        els.auth.classList.add('hidden');
        els.app.classList.remove('hidden');
        bindEvents();
        await selectView('home', false);
      });
      const ids = () => page.locator('.note-card').evaluateAll(cards => cards.map(card => Number(card.dataset.noteId)));
      const search = page.locator('#search-input');
      for (const view of ['home', 7, 8]) {
        await page.evaluate(view => selectView(view), view);
        assert.equal(await search.getAttribute('placeholder'), '搜索全部便签');
        await search.fill('火箭');
        await page.waitForFunction(() => state.notes.length === 3);
        assert.deepEqual(await ids(), [1, 2, 3]);
        assert.deepEqual(await page.locator('.note-card-group').allTextContents(), ['首页', '工作', '生活 <计划> 与长分组名称测试']);
        assert.equal(await page.locator('.note-card-group').evaluateAll(labels => labels.every(label => label.getBoundingClientRect().right <= label.closest('.note-card').getBoundingClientRect().right)), true);
        await page.locator('[data-note-id="3"]').click();
        assert.deepEqual(await page.evaluate(() => ({ group: state.currentGroup, search: state.search, note: state.currentNote.id })), { group: view, search: '火箭', note: 3 });
        assert.deepEqual(await ids(), [1, 2, 3]);
        if (width < 768) await page.evaluate(() => mobileView('list'));
        await page.locator('#clear-search').click();
        await page.waitForFunction(() => state.notes.length === 1);
        assert.deepEqual(await ids(), [view === 'home' ? 1 : view === 7 ? 2 : 3]);
        assert.equal(await search.inputValue(), '');
        assert.equal(await search.evaluate(el => document.activeElement === el), true);
        assert.equal(await page.locator('.note-card-group').count(), 0);
      }
      await page.evaluate(() => selectView('trash'));
      assert.equal(await search.getAttribute('placeholder'), '搜索回收站');
      await search.fill('火箭');
      await page.waitForFunction(() => document.querySelector('.note-card-group'));
      assert.deepEqual(await ids(), [4]);
      await search.fill('不存在');
      await page.waitForFunction(() => state.notes.length === 0);
      assert.equal(await page.locator('#note-list-empty strong').textContent(), '没有匹配的便签');
      await page.locator('#clear-search').click();
      await page.waitForFunction(() => state.notes.length === 1);
      assert.deepEqual(await ids(), [4]);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
