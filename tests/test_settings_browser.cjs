// Requires Playwright and Microsoft Edge: node --test tests/test_settings_browser.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Exercise the real markup, CSS and event handlers with an isolated admin API.
const html = read('templates/index.html')
  .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const script = read('static/app.js')
  .replace(/bindEvents\(\);\s*bindSecurityEvents\(\);\s*bootstrap\(\);\s*$/, '');

for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 1080 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`settings switches preserve the close button at ${viewport.width}x${viewport.height}`, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(html);
      await page.addStyleTag({ path: path.join(root, 'static/styles.css') });
      await page.addScriptTag({ content: script });
      await page.evaluate(async () => {
        state.user = { id: 1, display_name: '测试管理员', username: 'owner', is_admin: true, is_active: true };
        window.registrationOpen = true;
        window.failNextChange = false;
        api = async (url, options) => {
          if (url === '/api/admin/users') return { registration_open: window.registrationOpen, users: [state.user, { id: 2, username: 'member', display_name: '家庭成员', is_active: true }] };
          if (url === '/api/admin/registration') {
            if (window.failNextChange) { window.failNextChange = false; throw new Error('测试请求失败'); }
            window.registrationOpen = options.body.open;
            return { registration_open: window.registrationOpen };
          }
          return { enabled: false };
        };
        bindEvents();
        bindSecurityEvents();
        await openSettings();
      });
      const layout = () => page.evaluate(() => {
        const dialog = document.querySelector('#settings-dialog');
        const close = document.querySelector('#settings-close');
        const rect = close.getBoundingClientRect();
        return { scroll: dialog.scrollTop, top: rect.top, bottom: rect.bottom, reachable: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === close };
      });
      const initial = await layout();
      async function checkClose() {
        const current = await layout();
        assert.equal(current.scroll, 0, 'only the settings body may scroll');
        assert.equal(current.top, initial.top, 'close button must not move');
        assert.ok(current.reachable && current.top >= 0 && current.bottom <= viewport.height, 'close button remains visible and clickable');
      }
      const toggle = page.locator('#registration-toggle');
      const visibleSwitch = page.locator('#registration-toggle + .switch');
      await visibleSwitch.scrollIntoViewIfNeeded();
      await checkClose();
      // Both pointer and keyboard focus used to scroll the entire dialog.
      await visibleSwitch.click();
      assert.equal(await toggle.isChecked(), false);
      assert.equal(await page.evaluate(() => window.registrationOpen), false);
      await checkClose();
      await page.keyboard.press('Space');
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await page.evaluate(() => window.registrationOpen), true);
      await checkClose();
      await page.evaluate(() => { window.failNextChange = true; });
      await visibleSwitch.click();
      assert.equal(await toggle.isChecked(), true, 'failed requests restore the switch');
      await checkClose();
      await page.locator('[data-user-active="2"] + .switch').click();
      assert.equal(await page.locator('[data-user-active="2"]').isChecked(), false);
      await checkClose();
      // Also check layout after feedback expires and after reopening settings.
      await page.waitForFunction(() => !document.querySelector('.dialog-toast-region'));
      await checkClose();
      await page.locator('#settings-close').click();
      assert.equal(await page.locator('#settings-dialog').evaluate(el => el.open), false);
      await page.evaluate(() => openSettings());
      await checkClose();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#settings-dialog').evaluate(el => el.open), false);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
