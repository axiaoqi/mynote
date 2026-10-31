// NODE_PATH=work/browser/node_modules node --test tests/test_secure_data_browser.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
let server, base, instance;

before(async () => {
  const port = await new Promise(resolve => {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
  base = `http://127.0.0.1:${port}`;
  instance = path.join(root, 'work', `private-browser-${process.pid}`);
  const script = "import sys; from mynote import create_app; app=create_app({'TESTING':True,'INSTANCE_PATH':sys.argv[1]}); app.run(host='127.0.0.1',port=int(sys.argv[2]),use_reloader=False)";
  server = spawn(path.join(root, '.venv/Scripts/python.exe'), ['-c', script, instance, String(port)], { cwd: root, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/api/session')).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated test server did not start');
});
after(() => { server?.kill(); });

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`private note area, unlocked search, idle lock and backup settings at ${viewport.width}px`, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('#register-tab').click();
      await page.locator('#register-form input[name="username"]').fill(`qa${viewport.width}`);
      await page.locator('#register-form input[name="display_name"]').fill('测试账号');
      await page.locator('#register-form input[name="password"]').fill('login-password123');
      await page.locator('#register-form button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'));
      await page.evaluate(async () => { await api('/api/groups', { method: 'POST', body: { name: '普通分组' } }); await loadGroups(); });
      async function sidebar() {
        if (viewport.width < 768) {
          if (await page.evaluate(() => els.workspace.dataset.mobileView === 'editor')) await page.evaluate(() => backToList());
          if (await page.evaluate(() => els.workspace.dataset.mobileView !== 'sidebar')) await page.locator('#open-sidebar').click();
        }
      }
      await sidebar();
      await page.locator('#groups-toggle').click();
      assert.equal(await page.locator('#group-list').isVisible(), false);
      assert.equal(await page.locator('#groups-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mynote-navigation')).groupsCollapsed), true);
      await page.locator('#groups-toggle').click();
      assert.equal(await page.locator('#group-list').isVisible(), true);
      const placement = await page.evaluate(() => {
        const ordinary = document.querySelector('#group-list');
        const privateHeading = document.querySelector('.private-section-heading');
        return Boolean(ordinary.compareDocumentPosition(privateHeading) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      assert.equal(placement, true);
      assert.equal(await page.locator('#vault-open').textContent().then(text => text.trim()), '⚿ 账号密码');
      await page.locator('#vault-open').click();
      await page.locator('#vault-password-form input[name="current_password"]').fill('login-password123');
      await page.locator('#vault-password-form input[name="new_password"]').fill('private-password123');
      await page.locator('#vault-password-form input[name="confirm_password"]').fill('private-password123');
      await page.locator('#vault-password-form button').click();
      await page.waitForFunction(() => state.area === 'private' && !vaultUi.busy && !document.querySelector('#vault-dialog').open);
      assert.equal(await page.evaluate(() => state.currentGroup), 'all', 'account heading opens its own aggregate homepage');
      await sidebar();
      const selectedStyle = await page.evaluate(() => {
        const privateStyle = getComputedStyle(document.querySelector('#vault-open'));
        const homeStyle = getComputedStyle(document.querySelector('.main-nav .nav-item'));
        return { background: privateStyle.backgroundColor, radius: privateStyle.borderRadius, height: privateStyle.minHeight, homeRadius: homeStyle.borderRadius, homeHeight: homeStyle.minHeight };
      });
      assert.equal(selectedStyle.background, 'rgb(233, 233, 234)');
      assert.equal(selectedStyle.radius, selectedStyle.homeRadius);
      assert.equal(selectedStyle.height, selectedStyle.homeHeight);
      assert.equal(await page.locator('#private-new-group svg path').getAttribute('d'), await page.locator('#new-group-button svg path').getAttribute('d'), 'both add buttons use the same SVG plus');
      const addButtons = await page.locator('.group-add-button').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return [style.width, style.height, style.borderRadius, style.color];
      }));
      assert.deepEqual(addButtons[0], addButtons[1], 'add buttons share dimensions and color');
      assert.equal(await page.locator('#private-default-rename').count(), 0, 'there is no separate fixed default group row');
      await page.locator('#private-new-group').click();
      await page.locator('#input-dialog-field').fill('常用账号');
      await page.locator('#input-dialog-form .primary-button').click();
      await page.waitForFunction(() => state.privateGroups.some(group => group.name === '常用账号'));
      assert.equal(await page.locator('#list-title').textContent(), '账号密码');
      await page.locator('#private-new-group').click();
      await page.locator('#input-dialog-field').fill('网站');
      await page.locator('#input-dialog-form .primary-button').click();
      await page.locator('#private-group-list .nav-item').filter({ hasText: '网站' }).click();
      await page.locator('#new-note-button').click();
      await page.locator('#note-content').fill('秘密邮箱：alice@example.com，密码 secret-value');
      await page.waitForFunction(() => state.currentNote?.is_private && !state.dirty && !state.savePromise);
      await page.evaluate(async () => api('/api/notes', { method: 'POST', body: { content_html: '<p>独立首页便签</p>' } }));
      assert.equal(await page.locator('#vault-entry-form').count(), 0, 'ordinary editor replaces credential-manager fields');
      await sidebar();
      await page.locator('#vault-open').click();
      await page.waitForFunction(() => state.currentGroup === 'all' && state.notes.length === 2);
      assert.equal(await page.locator('#list-title').textContent(), '账号密码');
      await sidebar();
      await page.locator('#private-toggle').click();
      assert.equal(await page.locator('#private-navigation').isVisible(), false);
      assert.equal(await page.evaluate(() => state.currentGroup), 'all');
      assert.equal(await page.evaluate(async () => (await api('/api/vault')).unlocked), true, 'collapsing does not lock the private area');
      await page.locator('#private-toggle').click();
      await page.waitForFunction(() => !document.querySelector('#private-navigation').classList.contains('hidden'));
      const icons = await page.locator('#private-navigation .nav-item > svg').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
        return { center: rect.x + rect.width / 2, width: rect.width, height: rect.height, color: css.color, opacity: css.opacity };
      }));
      assert.equal(icons.length, 4);
      for (const icon of icons) {
        assert.ok(Math.abs(icon.center - icons[0].center) < 0.1, 'icons remain centered on the same vertical line');
        assert.equal(icon.color, icons[0].color);
        assert.equal(icon.opacity, icons[0].opacity);
      }
      assert.deepEqual(icons[0], icons[1], 'folder icons keep matching sizes');
      assert.deepEqual(icons[2], icons[3], 'trash and lock icons keep matching sizes');
      assert.ok(icons[2].width > icons[0].width && icons[2].width < icons[0].width * 1.2, 'action icons are only slightly larger');
      const labelPositions = await page.locator('#private-navigation .nav-item > span:last-child').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
      assert.ok(labelPositions.every(x => x === labelPositions[0]), 'private navigation labels line up');
      fs.mkdirSync(path.join(root, 'work'), { recursive: true });
      await page.screenshot({ path: path.join(root, `work/private-notes-${viewport.width}.png`) });
      await page.locator('.main-nav [data-view="home"]').click();
      await page.waitForFunction(() => state.area === 'normal' && (window.innerWidth > 760 || els.workspace.dataset.mobileView === 'list'));
      await sidebar();
      await page.locator('#private-toggle').click();
      await page.locator('#private-toggle').click();
      await page.waitForFunction(() => !document.querySelector('#private-navigation').classList.contains('hidden'));
      assert.equal(await page.evaluate(() => state.area), 'normal', 'expanding private navigation does not navigate away');
      assert.equal(await page.evaluate(() => state.currentGroup), 'home');
      if (viewport.width < 768) await page.locator('#sidebar-close').click();
      const expires = await page.evaluate(async () => (await api('/api/vault')).vault_expires_at);
      await page.locator('#search-input').fill('秘密邮箱');
      await page.waitForFunction(() => state.notes.some(note => note.is_private));
      assert.equal(await page.evaluate(async () => (await api('/api/vault')).vault_expires_at), expires, 'ordinary search does not renew the private grant');
      await page.locator('.note-card').filter({ hasText: '秘密邮箱' }).click();
      await page.waitForFunction(() => state.currentNote?.is_private);
      assert.equal(await page.evaluate(() => state.area), 'normal', 'search results remain in the ordinary search view');
      assert.match(await page.locator('#note-content').textContent(), /secret-value/);
      await page.clock.install();
      await page.clock.fastForward(300001);
      await page.waitForFunction(() => !state.currentNote && !state.notes.some(note => note.is_private));
      await page.waitForFunction(async () => !(await api('/api/vault')).unlocked);
      assert.equal(await page.locator('#note-content').textContent(), '');
      assert.equal(await page.evaluate(async () => (await api('/api/notes?q=秘密邮箱')).notes.length), 0, 'expired private notes cannot be searched');
      await sidebar();
      await page.locator('#private-toggle').click();
      await page.waitForFunction(() => !document.querySelector('#vault-unlock-form').classList.contains('hidden'));
      await page.locator('#vault-unlock-form input[name="password"]').fill('private-password123');
      await page.locator('#vault-unlock-form button').click();
      await page.waitForFunction(() => !vaultUi.busy && !document.querySelector('#vault-dialog').open && !document.querySelector('#private-navigation').classList.contains('hidden'));
      assert.equal(await page.evaluate(() => state.area), 'normal', 'unlocking via the arrow only expands navigation');
      await page.locator('#private-lock').click();
      await page.waitForFunction(async () => !(await api('/api/vault')).unlocked);
      await page.locator('#vault-open').click();
      await page.waitForFunction(() => !document.querySelector('#vault-unlock-form').classList.contains('hidden'));
      await page.locator('#vault-close').click();
      await page.evaluate(() => openSettings());
      await page.locator('#backup-form input[name="password"]').fill('zip-password123');
      await page.locator('#backup-form input[name="confirm_password"]').fill('zip-password123');
      await page.locator('#backup-form input[name="retention_days"]').fill('7');
      // The protected area must be unlocked before changing its backup settings.
      await page.evaluate(async () => api('/api/vault/unlock', { method: 'POST', body: { password: 'private-password123' } }));
      await page.locator('#backup-form button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('#backup-form input[name="password"]').value);
      assert.equal(await page.evaluate(async () => (await api('/api/backups')).config.retention_days), 7);
      assert.equal(await page.locator('#backup-current-password-label').isVisible(), true);
      await page.locator('#backup-form input[name="password"]').fill('updated-zip-password');
      await page.locator('#backup-form input[name="confirm_password"]').fill('updated-zip-password');
      assert.equal(await page.locator('#backup-form input[name="current_password"]').evaluate(input => input.required), true);
      assert.equal(await page.locator('#backup-form').evaluate(form => form.checkValidity()), false, 'changing ZIP password requires the old password');
      await page.locator('#backup-form input[name="current_password"]').fill('zip-password123');
      await page.locator('#backup-form button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('#backup-form input[name="password"]').value);
      await page.locator('#backup-now').click();
      await page.waitForFunction(() => document.querySelector('#backup-files a'));
      assert.match(await page.locator('#backup-password-status').textContent(), /已设置/);
      assert.match(await page.locator('#backup-form input[name="password"]').getAttribute('placeholder'), /已设置/);
      const backup = await page.evaluate(async () => api('/api/backups'));
      const filePath = path.resolve(instance, backup.config.directory.replace(/^instance\//, ''), backup.files[0].filename);
      assert.ok(filePath.startsWith(path.resolve(instance, 'backups') + path.sep));
      fs.unlinkSync(filePath);
      await page.locator('#backup-form input[name="time_of_day"]').fill('04:00');
      await page.locator('#backup-refresh').click();
      await page.waitForFunction(() => !document.querySelector('#backup-files a'));
      assert.match(await page.locator('#backup-files').textContent(), /暂无可用备份/);
      assert.equal(await page.locator('#backup-form input[name="time_of_day"]').inputValue(), '04:00', 'refreshing the file list preserves unsaved settings');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`panel resizing and long-press group sorting at ${viewport.width}px`, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport, hasTouch: viewport.width < 768, isMobile: viewport.width < 768 });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.waitForFunction(() => !document.querySelector('#auth-screen').classList.contains('hidden') && typeof bindGroupReorder === 'function');
      const normalIds = await page.evaluate(async username => {
        const data = await api('/api/register', { method: 'POST', body: { username, display_name: '布局测试', password: 'password123' } });
        await enterApp(data.user);
        const ids = [];
        for (const name of ['这是一个较长的分组名称便于测试宽度', '第二组" onmouseover="window.injected=1', '第三组']) ids.push((await api('/api/groups', { method: 'POST', body: { name } })).group.id);
        await loadGroups(); return ids;
      }, `layout${viewport.width}`);
      assert.equal(await page.locator('#group-list [onmouseover]').count(), 0, 'group names and tooltips remain text');
      let expectedWidths;
      if (viewport.width > 760) {
        const before = await page.locator('.sidebar').boundingBox();
        const separator = await page.locator('#sidebar-resizer').boundingBox();
        await page.mouse.move(separator.x + separator.width / 2, 350);
        await page.mouse.down(); await page.mouse.move(separator.x + separator.width / 2 + 110, 350, { steps: 5 }); await page.mouse.up();
        const after = await page.locator('.sidebar').boundingBox();
        assert.ok(after.width > before.width + 100);
        const listBefore = await page.locator('.note-list-pane').boundingBox();
        const second = await page.locator('#list-resizer').boundingBox();
        await page.mouse.move(second.x + second.width / 2, 350);
        await page.mouse.down(); await page.mouse.move(second.x + second.width / 2 + 70, 350, { steps: 5 }); await page.mouse.up();
        const listAfter = await page.locator('.note-list-pane').boundingBox();
        assert.ok(listAfter.width > listBefore.width + 60);
        assert.ok((await page.locator('.editor-pane').boundingBox()).width >= 280);
        expectedWidths = await page.evaluate(() => JSON.parse(localStorage.getItem('mynote-pane-widths')));
      } else {
        assert.equal(await page.locator('#sidebar-resizer').isVisible(), false);
        await page.locator('#open-sidebar').click();
      }
      const cdp = viewport.width < 768 ? await page.context().newCDPSession(page) : null;
      if (cdp) {
        const first = await page.locator('#group-list > .group-row').first().boundingBox();
        const x = first.x + 60, y = first.y + first.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 35, id: 0 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await page.evaluate(() => Boolean(groupDrag?.active)), false, 'quick touch scrolling does not start group sorting');
        assert.deepEqual(await page.evaluate(async () => (await api('/api/groups')).groups.map(group => group.id)), normalIds);
      }
      async function dragFirstToLast(selector) {
        const first = await page.locator(selector + ' > .group-row').first().boundingBox();
        const last = await page.locator(selector + ' > .group-row').last().boundingBox();
        const x = first.x + 65, start = first.y + first.height / 2, end = last.y + last.height - 3;
        if (cdp) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start, id: 0 }] });
          await page.waitForTimeout(420);
          assert.equal(await page.evaluate(() => Boolean(groupDrag?.active)), true);
          for (let step = 1; step <= 4; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 4, id: 0 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await page.mouse.move(x, start); await page.mouse.down(); await page.waitForTimeout(420);
          assert.equal(await page.evaluate(() => Boolean(groupDrag?.active)), true);
          await page.mouse.move(x, end, { steps: 5 }); await page.mouse.up();
        }
        await page.waitForFunction(() => !groupOrderSaving && !groupDrag);
        await page.waitForFunction(() => Date.now() >= suppressGroupClickUntil);
      }
      await dragFirstToLast('#group-list');
      assert.deepEqual(await page.evaluate(async () => (await api('/api/groups')).groups.map(group => group.id)), normalIds.slice(1).concat(normalIds[0]));
      assert.equal(await page.evaluate(() => state.currentGroup), 'home', 'drag release does not select the dragged group');
      const privateIds = await page.evaluate(async () => {
        await api('/api/vault/password', { method: 'POST', body: { current_password: 'password123', new_password: 'private-password123', confirm_password: 'private-password123' } });
        await enterPrivateArea();
        const ids = [];
        for (const name of ['国外账号密码', '私密二组', '私密三组']) ids.push((await api('/api/groups', { method: 'POST', body: { name } })).group.id);
        await loadGroups(); return ids;
      });
      if (viewport.width < 768) await page.locator('#open-sidebar').click();
      await dragFirstToLast('#private-group-list');
      assert.deepEqual(await page.evaluate(async () => (await api('/api/groups')).groups.map(group => group.id)), privateIds.slice(1).concat(privateIds[0]));
      assert.equal(await page.evaluate(() => state.currentGroup), 'all');
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'));
      assert.deepEqual(await page.evaluate(async () => (await api('/api/groups')).groups.map(group => group.id)), normalIds.slice(1).concat(normalIds[0]));
      if (expectedWidths) {
        assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width), expectedWidths.sidebar);
        assert.equal(Math.round((await page.locator('.note-list-pane').boundingBox()).width), expectedWidths.list);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
