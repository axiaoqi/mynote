// Run with: node --test tests/test_editor_frontend.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8')
  .replace(/bindEvents\(\);\s*bindSecurityEvents\(\);\s*bootstrap\(\);\s*$/, '');

function setup(input, { collapsed = false, inside = true } = {}) {
  const calls = [];
  const range = {
    collapsed, commonAncestorContainer: {},
    cloneRange() { return { ...this }; },
    selectNodeContents() {}, collapse() { this.collapsed = true; },
  };
  const selection = {
    rangeCount: 1, getRangeAt: () => range,
    removeAllRanges() { calls.push('clear selection'); },
    addRange(saved) { calls.push(['restore selection', saved.collapsed]); },
  };
  const editor = { contains: () => inside, focus() { calls.push('focus'); } };
  const ctx = vm.createContext({
    URL, URLSearchParams, console,
    window: { getSelection: () => selection, prompt() { calls.push('prompt'); return input; } },
    document: {
      querySelector: () => editor, createRange: () => ({ ...range }),
      createElement: () => ({
        set textContent(value) { this.innerHTML = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      }),
      execCommand(...args) { calls.push(args); return true; },
    },
  });
  vm.runInContext(source, ctx);
  ctx.toast = (...args) => calls.push(['toast', ...args]);
  return { ctx, calls };
}

test('link addresses support bare domains and reject unsafe or malformed schemes', () => {
  const { ctx } = setup();
  assert.equal(ctx.normalizeLinkUrl(' example.com/page '), 'https://example.com/page');
  assert.equal(ctx.normalizeLinkUrl('mailto:hello@example.com'), 'mailto:hello@example.com');
  assert.equal(ctx.normalizeLinkUrl('http://example.com'), 'http://example.com');
  for (const input of ['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com', 'https://', 'mailto:', 'not a url']) {
    assert.equal(ctx.normalizeLinkUrl(input), null, input);
  }
});

test('selected text is restored after the prompt and receives the link', () => {
  const { ctx, calls } = setup('example.com');
  assert.equal(ctx.insertEditorLink(), true);
  assert.deepEqual(calls, ['prompt', 'focus', 'clear selection', ['restore selection', false], ['createLink', false, 'https://example.com']]);
});

test('a cursor or selection outside the editor inserts visible link text', () => {
  for (const options of [{ collapsed: true }, { inside: false }]) {
    const { ctx, calls } = setup('example.com', options);
    assert.equal(ctx.insertEditorLink(), true);
    assert.deepEqual(calls.at(-1), ['insertHTML', false, '<a href="https://example.com">https://example.com</a>']);
  }
});

test('inserted URLs cannot break out of the href attribute', () => {
  const { ctx, calls } = setup('https://example.com/"<b>&', { collapsed: true });
  ctx.insertEditorLink();
  assert.deepEqual(calls.at(-1), ['insertHTML', false, '<a href="https://example.com/&quot;&lt;b&gt;&amp;">https://example.com/"&lt;b&gt;&amp;</a>']);
});

test('cancelled, empty and invalid addresses never change the document', () => {
  for (const input of [null, '', '  ', 'javascript:alert(1)']) {
    const { ctx, calls } = setup(input);
    assert.equal(ctx.insertEditorLink(), false);
    assert.equal(calls.some(call => Array.isArray(call) && ['createLink', 'insertHTML'].includes(call[0])), false);
  }
});
