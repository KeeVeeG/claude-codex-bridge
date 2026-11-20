import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../ui/bridge.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'The self-contained panel must contain its application script.');

class Node {
  constructor(tag = 'div', doc = null) { this.tagName = tag; this.doc = doc; this.children = []; this.attributes = {}; this.dataset = {};
    this.style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); }, getPropertyValue(name) { return this.values.get(name) || ''; } };
    this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.listeners = new Map();
    this.scrollTop = 0; this.scrollHeight = 500; this.clientHeight = 200; this._text = ''; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(value) { throw new Error('Transcript rendering must not use innerHTML.'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; this.scrollHeight = nodes.length * 90; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  dispatch(type, props = {}) { let prevented = false; for (const listener of this.listeners.get(type) || []) listener({ preventDefault() { prevented = true; }, key: '', isComposing: false, ...props }); return prevented; }
  focus() { this.focused = true; if (this.doc) this.doc.activeElement = this; }
  get classList() {
    const change = (name, on) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); on ? classes.add(name) : classes.delete(name); this.className = [...classes].join(' '); };
    return { add: name => change(name, true), remove: name => change(name, false), toggle: (name, on) => change(name, on) };
  }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const flush = async () => { for (let index = 0; index < 18; index++) await Promise.resolve(); };

function harness(hash = '', { now, storage } = {}) {
  const document = { activeElement: null, getElementById: id => nodes.get(id), createElement: tag => new Node(tag, document), documentElement: new Node('html'), visibilityState: 'visible' };
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Node('div', document)]));
  const parent = {}; const outgoing = []; const listeners = new Map(); const timers = new Map(); const intervals = []; const cleared = [];
  let timerId = 0; let uuid = 0;
  parent.postMessage = (message, origin) => outgoing.push({ message: JSON.parse(JSON.stringify(message)), origin });
  const window = { parent, sessionStorage: storage, addEventListener(type, listener) { listeners.set(type, listener); } };
  const context = vm.createContext({ window, document, location: { hash }, TextEncoder, console,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, {callback, ms}); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: callback => intervals.push(callback), clearInterval: id => cleared.push(id),
  });
  if (now !== undefined) vm.runInContext(`Date.now = () => ${now};`, context);
  const bootstrap = new vm.Script(`(async () => { ${script}\n })()`).runInContext(context);
  const emit = (message, { source = parent, origin = 'https://desktop.example' } = {}) => listeners.get('message')?.({ source, origin, data: message });
  const reply = (request, data, options = {}) => emit({ jsonrpc: '2.0', id: request.message.id, result: { structuredContent: data } }, options);
  const requests = name => outgoing.filter(entry => entry.message.method === 'tools/call' && entry.message.params.name === name);
  return { nodes, outgoing, parent, emit, reply, requests, bootstrap, document, intervals, cleared, timers,
    node: id => nodes.get(id), uuidCount: () => uuid,
    result: (request, result) => emit({ jsonrpc: '2.0', id: request.message.id, result }),
    async choose(sessionId, messages = [], page = {}) {
      const button = nodes.get('chat-list').children.find(child => child.dataset.sessionId === sessionId);
      assert.ok(button, `Conversation ${sessionId} must be visible.`); button.dispatch('click'); await flush();
      const request = requests('panel_history').at(-1);
      if (request?.message.params.arguments.session_id === sessionId) { reply(request, { session_id: sessionId, messages, has_more: false, next_cursor: null, ...page }); await flush(); }
    },
  };
}

const panel = {
  owner_thread_id: 'codex-owner', application: 'codex', sessions: [
    { session_id: 'a', title: 'Bridge interface', cwd: 'C:/projects/bridge', live: true, last_contact_at: 1000, last_activity_at: 4000 },
    { session_id: 'b', title: 'Test review', cwd: 'C:/projects/tests', live: true, last_contact_at: 2000, last_activity_at: 3000 },
    { session_id: 'c', title: 'Archive', cwd: 'C:/projects/history', live: false, last_contact_at: 1000, last_activity_at: 2000 },
    { session_id: 'd', title: 'New session', cwd: 'C:/projects/prototype', live: true, last_contact_at: null, last_activity_at: 1000 },
  ],
};
async function live(h = harness(), sessions = panel.sessions) {
  const request = h.outgoing[0];
  h.emit({ jsonrpc: '2.0', id: request.message.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } });
  await flush(); h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: launcher(sessions) }); await flush(); await h.bootstrap; return h;
}
// A 1.1 launcher result: the model-visible part lists live sessions; the panel's catalog travels in _meta (PR02).
const CATALOG = 'bridge-claude-codex/catalog';
function launcher(sessions = panel.sessions, { cursor = null, warnings = [], owner = 'codex-owner' } = {}) {
  return { structuredContent: { ...panel, owner_thread_id: owner, sessions: sessions.filter(chat => chat.live), composer_enter_behavior: 'cmdAlways' },
    _meta: { [CATALOG]: { sessions, warnings, next_cursor: cursor } } };
}
const type = (h, text) => { h.node('message').value = text; h.node('message').dispatch('input'); };
const timelineButton = (h, label) => descendants(h.node('timeline')).find(node => node.tagName === 'button' && node.textContent === label);
const alertButton = (h, label) => h.node('alert-actions').children.find(node => node.textContent === label);
const bubbles = h => descendants(h.node('timeline')).filter(node => node.className === 'bubble');
const texts = (h, className) => descendants(h.node('timeline')).filter(node => node.className === className).map(node => node.textContent);
const errorResult = (text, outcome, extra = {}) => ({ isError: true, content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify({ outcome, ...extra }) }] });
const delivery = (id, text, extra = {}) => ({ message_id: id, message: text, from: { app: 'codex', id: 'codex-owner' }, to: { app: 'claude', id: 'a' }, created_at: 1000, status: 'submitted', ...extra });
const record = (id, text, extra = {}) => ({ id, message: text, direction: 'to_claude', created_at: 1000, status: 'submitted', ...extra });

test('panel distinguishes live CLI and Desktop recipients while preserving exact selected IDs', async () => {
  const h = await live();
  const chats = panel.sessions.map(chat => ({ ...chat,
    ...(chat.session_id === 'a' ? { entrypoint: 'cli' } : chat.session_id === 'b' ? { entrypoint: 'claude-desktop' }
      : chat.session_id === 'd' ? { entrypoint: 'sdk-cli' } : {}) }));
  chats.push({ session_id: 'e', title: 'Editor session', cwd: 'C:/projects/editor', live: true, last_contact_at: null,
    last_activity_at: 500, entrypoint: 'claude-vscode' });
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { ...panel, sessions: chats } } });
  await flush();
  const cli = h.node('chat-list').children.find(node => node.dataset.sessionId === 'a');
  const desktop = h.node('chat-list').children.find(node => node.dataset.sessionId === 'b');
  assert.match(cli.textContent, /Claude CLI/);
  assert.match(cli.attributes['aria-label'], /Claude CLI/);
  assert.match(desktop.textContent, /Claude Desktop/);
  h.node('tab-all').dispatch('click'); await flush();
  const print = h.node('chat-list').children.find(node => node.dataset.sessionId === 'd');
  assert.match(print.textContent, /Claude CLI \(print\)/);
  const editor = h.node('chat-list').children.find(node => node.dataset.sessionId === 'e');
  assert.match(editor.textContent, /Claude VS Code/);
  await h.choose('a');
  assert.match(h.node('conversation-subtitle').textContent, /Claude CLI/);
  h.node('message').value = 'CLI recipient message'; h.node('message').dispatch('input');
  h.node('composer').dispatch('submit'); await flush();
  assert.equal(h.requests('panel_send').at(-1).message.params.arguments.session_id, 'a');
});

test('panel negotiates the MCP Apps bridge and pins both parent source and origin', async () => {
  const h = harness(); const init = h.outgoing[0];
  assert.equal(init.message.method, 'ui/initialize'); assert.equal(init.origin, '*');
  h.emit({ jsonrpc: '2.0', id: init.message.id, result: { protocolVersion: '2026-01-26' } }, { source: {} });
  await flush(); assert.equal(h.requests('bridge_panel').length, 0);
  h.emit({ jsonrpc: '2.0', id: init.message.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } });
  await flush(); assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.ok(h.outgoing.some(entry => entry.message.method === 'ui/notifications/initialized'));
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panel } }, { origin: 'https://untrusted.example' }); await flush(); assert.equal(h.node('chat-count').textContent, '0');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panel } }); await flush(); await h.bootstrap; assert.equal(h.node('chat-count').textContent, '3 / 4');
  assert.equal(h.requests('panel_history').length, 0, 'No destination may be selected implicitly.');
  assert.equal(h.requests('panel_send').length, 0);
});

test('unsupported UI protocol fails visibly without loading tools', async () => {
  const h = harness(); h.emit({ jsonrpc: '2.0', id: h.outgoing[0].message.id, result: { protocolVersion: 'unsupported' } });
  await flush(); await h.bootstrap;
  assert.equal(h.node('connection-error').hidden, false); assert.match(h.node('connection-error').textContent, /supported UI version/);
  assert.equal(h.requests('bridge_panel').length, 0);
});

test('history errors replace the loading placeholder with a retryable state', async () => {
  const h = await live();
  const button = h.node('chat-list').children.find(child => child.dataset.sessionId === 'a');
  button.dispatch('click'); await flush();
  const request = h.requests('panel_history').at(-1);
  h.emit({ jsonrpc: '2.0', id: request.message.id, error: { message: 'History unavailable.' } }); await flush();
  assert.match(h.node('timeline').textContent, /History unavailable/);
  assert.doesNotMatch(h.node('timeline').textContent, /Loading history/);
  assert.match(h.node('alert-text').textContent, /History unavailable/);
});

test('native color, typography, and partial theme updates use host CSS variables', async () => {
  const h = harness(); const init = h.outgoing[0]; const style = h.document.documentElement.style;
  h.emit({ jsonrpc: '2.0', id: init.message.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark', styles: { variables: {
    '--color-background-primary': '#181818', '--color-background-secondary': '#303030', '--color-background-tertiary': '#1b1b1b',
    '--color-text-primary': '#ffffff', '--color-border-secondary': '#292929', '--font-sans': 'Custom System Font', '--font-weight-normal': '430',
    '--font-text-md-size': '14px', color: 'unexpected',
  } } } } });
  await flush(); h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panel } }); await flush(); await h.bootstrap;
  assert.equal(style.getPropertyValue('--font-sans'), 'Custom System Font'); assert.equal(style.getPropertyValue('--font-weight-normal'), '430');
  assert.equal(style.getPropertyValue('--color-background-primary'), '#181818'); assert.equal(style.getPropertyValue('color'), '');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { styles: { variables: { '--color-background-primary': '#faf7ee', '--color-text-primary': '#181611' } } } });
  await flush(); assert.equal(h.document.documentElement.dataset.theme, 'dark'); assert.equal(style.getPropertyValue('--color-background-primary'), '#faf7ee');
  assert.equal(style.getPropertyValue('--font-sans'), 'Custom System Font', 'A partial update must retain the chosen native font.');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light', styles: { variables: { '--color-background-secondary': '#eee8da' } } } });
  await flush(); assert.equal(h.document.documentElement.dataset.theme, 'light'); assert.equal(style.getPropertyValue('--color-background-secondary'), '#eee8da');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { styles: { variables: { '--font-sans': 'Attacker Font' } } } }, { origin: 'https://untrusted.example' });
  await flush(); assert.equal(style.getPropertyValue('--font-sans'), 'Custom System Font');
  assert.match(html, /background: var\(--bg\)/); assert.match(html, /--bg: var\(--color-background-primary/);
  assert.match(html, /--sidebar: var\(--color-background-tertiary/); assert.match(html, /--composer: var\(--color-background-secondary/);
});

test('composer keeps Codex-like rhythm and a fixed circular send control', () => {
  assert.match(html, /\.composer \{ padding: 13px 14px 10px;/);
  assert.match(html, /\.composer-bottom \{[^}]*justify-content: flex-end/);
  assert.match(html, /\.composer-bottom \{[^}]*min-height: 32px/);
  assert.doesNotMatch(html, /\.composer-target::before/);
  assert.doesNotMatch(html, /<span class="composer-target"/);
  assert.match(html, /\.send-button \{[^}]*flex: 0 0 32px/);
  assert.match(html, /\.send-button \{[^}]*aspect-ratio: 1 \/ 1/);
  assert.match(html, /\.send-button \{[^}]*min-width: 32px/);
  assert.match(html, /\.send-button \{[^}]*max-width: 32px/);
});

test('per-chat drafts survive selection, search finds projects, and inactive history blocks sends', async () => {
  const h = await live(); await h.choose('a');
  h.node('message').value = 'Draft A'; h.node('message').dispatch('input');
  await h.choose('b'); assert.equal(h.node('message').value, ''); h.node('message').value = 'Draft B'; h.node('message').dispatch('input');
  await h.choose('a'); assert.equal(h.node('message').value, 'Draft A');
  await h.choose('c', [record('archive', 'History is available.')]);
  assert.equal(h.node('composer').hidden, true); assert.match(h.node('inactive-title').textContent, /Not available for sending/);
  h.node('message').dispatch('keydown', { key: 'Enter', ctrlKey: true }); await flush(); assert.equal(h.requests('panel_send').length, 0);
  h.node('tab-all').dispatch('click'); h.node('search').value = 'prototype'; h.node('search').dispatch('input');
  assert.deepEqual(h.node('chat-list').children.map(node => node.dataset.sessionId), ['d']);
});

test('K03, X02, U03, Z01: Enter sends only when the host reports that Codex sends on Enter; otherwise the hint says Enter adds a line', async () => {
  const h = await live(); await h.choose('a');
  assert.equal(h.node('composer-hint').textContent, 'Enter adds a line · Ctrl+Enter sends (Codex did not share its Enter setting)');
  type(h, 'First line');
  for (const modifiers of [{}, {shiftKey: true}, {isComposing:true,ctrlKey:true}]) assert.equal(h.node('message').dispatch('keydown', {key:'Enter',...modifiers}),false); await flush();
  assert.equal(h.requests('panel_send').length, 0);
  // Launcher data cannot make Enter send: a config.toml value is not what Codex applies.
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { ...launcher(), structuredContent: { ...launcher().structuredContent, composer_enter_behavior: 'enter' } } }); await flush();
  h.node('message').dispatch('keydown', { key: 'Enter' }); await flush();
  assert.equal(h.requests('panel_send').length, 0);
  h.node('message').dispatch('keydown', { key: 'Enter', ctrlKey: true }); await flush();
  assert.equal(h.requests('panel_send').length, 1);

  const second = harness();
  second.emit({ jsonrpc: '2.0', id: second.outgoing[0].message.id, result: { protocolVersion: '2026-01-26', hostContext: { composer: { enterBehavior: 'enter' } } } });
  await flush(); second.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: launcher() }); await flush(); await second.bootstrap;
  await second.choose('a'); assert.equal(second.node('composer-hint').textContent, 'Enter sends · Shift+Enter adds a line');
  type(second, 'Send with Enter');
  second.node('message').dispatch('keydown', { key: 'Enter', shiftKey: true }); await flush();
  assert.equal(second.requests('panel_send').length, 0);
  assert.equal(second.node('message').dispatch('keydown', { key: 'Enter' }),true); await flush();
  assert.equal(second.requests('panel_send').length, 1);
});

async function checkHistoryOnly(h, messages, extra = {}) {
  const before = h.outgoing.length;
  alertButton(h, 'Check again').dispatch('click'); await flush();
  assert.deepEqual(h.outgoing.slice(before).map(call => call.message.params.name), ['panel_history']);
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages, has_more: false, next_cursor: null, ...extra }); await flush();
}

test('A08: after a lost reply, checking absent, incomplete or unresolved history never resends or releases the draft', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Exact text');
  h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1); const args = send.message.params.arguments;
  assert.deepEqual(Object.keys(args).sort(), ['message', 'message_id', 'session_id']); assert.equal(args.session_id, 'a'); assert.equal(args.message, 'Exact text');
  h.emit({ jsonrpc: '2.0', id: send.message.id, result: { isError: true, content: [{ type: 'text', text: 'Transport ended.' }] } }); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [], has_more: false, next_cursor: null, warnings: [] }); await flush();
  assert.equal(h.uuidCount(), 1); assert.equal(h.node('send').disabled, true);
  assert.match(h.node('alert-text').textContent, /Codex did not confirm the handoff/);
  assert.ok(descendants(h.node('timeline')).some(node => node.textContent === 'Handoff not confirmed'));
  type(h, 'Edited meanwhile');
  h.node('composer').dispatch('submit'); h.node('message').dispatch('keydown', { key: 'Enter', ctrlKey: true }); await flush();
  assert.equal(h.requests('panel_send').length, 1);
  const row = record(args.message_id, args.message, { manual: true });
  for (const [messages, extra] of [[[], {}], [[row], { incomplete: true }], [[{ ...row, status: undefined }], {}], [[{ ...row, status: 'uncertain' }], {}], [[{ ...row, status: 'failed' }], {}]]) {
    await checkHistoryOnly(h, messages, extra);
    if (extra.incomplete) assert.match(h.node('alert-text').textContent, /History is incomplete/);
    h.node('composer').dispatch('submit'); await flush();
    assert.equal(h.requests('panel_send').length, 1); assert.equal(h.uuidCount(), 1);
    assert.equal(h.node('send').disabled, true); assert.equal(h.node('message').value, 'Edited meanwhile');
  }
  await checkHistoryOnly(h, [row]);
  assert.equal(h.node('send').disabled, false); assert.equal(h.node('message').value, 'Edited meanwhile', 'Only the sent revision is cleared.');
  assert.equal(h.requests('panel_send').length, 1); assert.equal(h.uuidCount(), 1);
});

test('A08: a same-ID history row with different text cannot settle an unknown send', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Original body');
  h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1); const id = send.message.params.arguments.message_id;
  h.reply(send, { delivery: delivery(id, 'Different body') }); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [record(id, 'Different body')], has_more: false, next_cursor: null }); await flush();
  assert.equal(h.node('send').disabled, true, 'A mismatched history row does not release the unresolved send.');
  assert.equal(h.node('message').value, 'Original body');
  assert.match(h.node('alert-text').textContent, /No matching handoff in the history checked/);
  await checkHistoryOnly(h, [record(id, 'Original body')]);
  assert.equal(h.requests('panel_send').length, 1);
  assert.equal(h.node('message').value, ''); assert.deepEqual(bubbles(h).map(node => node.textContent), ['Original body']);
});

test('A08: retry:inspect offers only a read, makes no write claim, and cannot promote a failed history row to permission to resend', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Inspect this');
  h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1); const id = send.message.params.arguments.message_id;
  h.reply(send, { delivery: delivery(id, 'Inspect this', { status: 'failed' }), outcome: { delivered: 'unknown', reason: 'prior_failed', retry: 'inspect' } }); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [], warnings: [], has_more: false, next_cursor: null }); await flush();
  assert.match(h.node('alert-text').textContent, /handoff to Claude Code is not confirmed/);
  assert.doesNotMatch(h.node('alert-text').textContent, /bridge wrote|arrived|Claude Code has the message/i);
  assert.deepEqual(h.node('alert-actions').children.map(node => node.textContent), ['Check again']);
  await checkHistoryOnly(h, [record(id, 'Inspect this', { status: 'failed' })]);
  h.node('composer').dispatch('submit'); await flush();
  assert.equal(h.node('send').disabled, true); assert.equal(h.node('message').value, 'Inspect this');
  assert.equal(h.requests('panel_send').length, 1); assert.equal(h.uuidCount(), 1);
});

test('messages remain literal text and pagination prepends without moving the visible anchor', async () => {
  const h = await live(); const text = '<img src=x onerror="steal()"> & <script>run()</script>';
  await h.choose('a', [record('recent', text), record('reply', 'Reply', { direction: 'to_codex', created_at: 2000 })], { has_more: true, next_cursor: 'older-page' });
  const pane = h.node('timeline'); assert.ok(descendants(pane).some(node => node.className === 'bubble' && node.textContent === text));
  pane.scrollTop = 50; const height = pane.scrollHeight;
  descendants(pane).find(node => node.tagName === 'button' && node.textContent === 'Load earlier messages').dispatch('click'); await flush();
  const request = h.requests('panel_history').at(-1); assert.equal(request.message.params.arguments.cursor, 'older-page');
  h.reply(request, { session_id: 'a', messages: [record('older', 'Earlier message', { created_at: 500 })], has_more: false, next_cursor: null }); await flush();
  assert.deepEqual(descendants(pane).filter(node => node.className === 'bubble').map(node => node.textContent), ['Earlier message', text, 'Reply']);
  assert.equal(pane.scrollTop, 50 + pane.scrollHeight - height);
  assert.ok(descendants(pane).some(node => node.className === 'message-label' && node.textContent === 'Codex'), 'Automatic agent messages must not be attributed to the human.');
});

test('background refresh preserves an earlier reading position while merging new messages', async () => {
  const h = await live(); const messages = [record('one', 'First'), record('two', 'Second', { created_at: 2000 }), record('three', 'Third', { created_at: 3000 })];
  await h.choose('a', messages); const pane = h.node('timeline'); pane.scrollTop = 30;
  h.intervals[0](); await flush(); h.reply(h.requests('bridge_panel').at(-1), panel); await flush();
  assert.equal(pane.scrollTop, 30, 'Refreshing chat metadata must not jump to the latest message.');
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [...messages, record('four', 'New', { created_at: 4000 })], has_more: false, next_cursor: null }); await flush();
  assert.equal(pane.scrollTop, 30); assert.ok(descendants(pane).some(node => node.className === 'bubble' && node.textContent === 'New'));
});

test('Codex notice retry is explicit and available only after definitive failure, without a Claude send', async () => {
  const h = await live(); await h.choose('a', [
    record('safe', 'Already delivered to Claude.', { manual: true, notice_status: 'failed', notice_retryable: true }),
    record('unknown', 'Notice status is uncertain.', { manual: true, notice_status: 'uncertain', notice_retryable: false }),
    record('unsafe', 'Result write failed.', { manual: true, notice_status: 'failed', notice_retryable: false }),
  ]);
  const buttons = descendants(h.node('timeline')).filter(node => node.textContent === 'Post the copy again'); assert.equal(buttons.length, 1);
  assert.equal(h.requests('panel_retry_notice').length, 0); buttons[0].dispatch('click'); buttons[0].dispatch('click'); await flush();
  const retry = h.requests('panel_retry_notice').at(-1); assert.deepEqual(retry.message.params.arguments, { session_id: 'a', message_id: 'safe' });
  assert.equal(h.requests('panel_retry_notice').length, 1); assert.equal(h.requests('panel_send').length, 0);
  h.reply(retry, { delivery: delivery('safe', 'Already delivered to Claude.', { manual: true }), manual: true, notice_status: 'submitted', notice_retryable: false }); await flush();
  assert.ok(texts(h, 'notice-detail').includes('Copy posted in this Codex chat'));
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [record('safe', 'Already delivered to Claude.', { manual: true, notice_status: 'submitted' })], has_more: false, next_cursor: null }); await flush();
  assert.equal(h.requests('panel_send').length, 0);
});

test('owner-context changes disable sending, and demo never calls a real host', async () => {
  const h = await live(); await h.choose('a'); h.node('message').value = 'Draft'; h.node('message').dispatch('input');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { ...panel, owner_thread_id: 'different-owner' } } }); await flush();
  assert.equal(h.node('send').disabled, true); assert.match(h.node('connection-error').textContent, /Codex context changed/);
  const d = harness('#demo'); await flush(); await d.bootstrap;
  assert.equal(d.node('demo-banner').hidden, false); assert.match(d.node('demo-banner').textContent || html, /No real messages are sent/);
  d.node('message').value = 'Demo only'; d.node('message').dispatch('input'); d.node('composer').dispatch('submit'); await flush();
  assert.equal(d.outgoing.length, 0); assert.ok(descendants(d.node('timeline')).some(node => node.className === 'bubble' && node.textContent === 'Demo only'));
});

test('U01: the reply for a sent text never erases a draft written while it was sending', async () => {
  const h = await live(); await h.choose('a'); type(h, 'First');
  h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1);
  type(h, 'Second');
  h.reply(send, { delivery: delivery(send.message.params.arguments.message_id, 'First', { manual: true }), manual: true, notice_status: 'submitted' }); await flush();
  assert.equal(h.node('message').value, 'Second');
  assert.equal(h.node('message').disabled, false); assert.equal(h.node('send').disabled, false);
  assert.ok(bubbles(h).some(node => node.textContent === 'First'));
});

test('U02: a newest page that does not reach the shown rows replaces them, so no hole opens; older pages fill back in order', async () => {
  const h = await live();
  await h.choose('a', [record('m1', 'One', { created_at: 1000 }), record('m2', 'Two', { created_at: 2000 })]);
  const poll = async page => { h.intervals[0](); await flush(); h.result(h.requests('bridge_panel').at(-1), launcher()); await flush();
    h.reply(h.requests('panel_history').at(-1), { session_id: 'a', ...page }); await flush(); };
  await poll({ messages: [record('m4', 'Four', { created_at: 4000 }), record('m5', 'Five', { created_at: 5000 })], has_more: true, next_cursor: 'p2' });
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['Four', 'Five']);
  timelineButton(h, 'Load earlier messages').dispatch('click'); await flush();
  const older = h.requests('panel_history').at(-1); assert.equal(older.message.params.arguments.cursor, 'p2');
  h.reply(older, { session_id: 'a', messages: [record('m2', 'Two', { created_at: 2000 }), record('m3', 'Three', { created_at: 3000 })], has_more: true, next_cursor: 'p3' }); await flush();
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['Two', 'Three', 'Four', 'Five']);
  await poll({ messages: [record('m5', 'Five', { created_at: 5000 }), record('m6', 'Six', { created_at: 6000 })], has_more: true, next_cursor: 'p2b' });
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['Two', 'Three', 'Four', 'Five', 'Six'], 'An overlapping newest page keeps the older rows.');
  timelineButton(h, 'Load earlier messages').dispatch('click'); await flush();
  assert.equal(h.requests('panel_history').at(-1).message.params.arguments.cursor, 'p3');
});

test('U04: host requests are answered by method, never taken for a pending call with the same ID, and teardown stops polling', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Hold');
  h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1);
  h.emit({ jsonrpc: '2.0', id: send.message.id, method: 'ping' }); await flush();
  assert.deepEqual(h.outgoing.at(-1).message, { jsonrpc: '2.0', id: send.message.id, result: {} });
  assert.equal(h.node('send').disabled, true, 'A request that reuses the ID is not the send response.');
  h.emit({ jsonrpc: '2.0', id: 'host-7', method: 'ui/unknown-request' }); await flush();
  assert.equal(h.outgoing.at(-1).message.error.code, -32601);
  h.reply(send, { delivery: delivery(send.message.params.arguments.message_id, 'Hold', { manual: true }), manual: true, notice_status: 'submitted' }); await flush();
  assert.ok(bubbles(h).some(node => node.textContent === 'Hold'));
  h.emit({ jsonrpc: '2.0', id: 'teardown-1', method: 'ui/resource-teardown', params: {} }); await flush();
  assert.deepEqual(h.outgoing.at(-1).message, { jsonrpc: '2.0', id: 'teardown-1', result: {} });
  assert.deepEqual(h.cleared, [1]);
  const calls = h.outgoing.length; h.intervals[0](); await flush();
  assert.equal(h.outgoing.length, calls, 'A torn-down panel does not poll.');
});

test('U05: rows with equal timestamps keep the server order across pages', async () => {
  const h = await live();
  await h.choose('a', [record('c', 'Third', { created_at: 1000 }), record('b', 'Fourth', { direction: 'to_codex', created_at: 1000 })], { has_more: true, next_cursor: 'older' });
  timelineButton(h, 'Load earlier messages').dispatch('click'); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [record('z', 'First', { created_at: 1000 }), record('a', 'Second', { created_at: 1000 })], has_more: false, next_cursor: null }); await flush();
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['First', 'Second', 'Third', 'Fourth']);
});

test('U06: a refresh keeps keyboard focus on the timeline control that had it', async () => {
  const h = await live();
  await h.choose('a', [record('one', 'One')], { has_more: true, next_cursor: 'older' });
  const control = () => descendants(h.node('timeline')).find(node => node.tagName === 'button' && node.textContent === 'Load earlier messages');
  control().focus();
  h.intervals[0](); await flush(); h.result(h.requests('bridge_panel').at(-1), launcher()); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [record('one', 'One'), record('two', 'Two', { created_at: 2000 })], has_more: true, next_cursor: 'older' }); await flush();
  assert.ok(bubbles(h).some(node => node.textContent === 'Two'));
  assert.equal(h.document.activeElement, control());
});

test('U07 and U208: Send is enabled only for a draft the server takes, and the reason is visible beside the kept draft', async () => {
  assert.doesNotMatch(html, /<textarea[^>]*maxlength/);
  const h = await live(); await h.choose('a');
  type(h, 'é'.repeat(32768));
  assert.equal(h.node('send').disabled, false); assert.match(h.node('composer-hint').textContent, /^65,536 of 65,536 bytes · /);
  type(h, '漢'.repeat(21846));
  assert.equal(h.node('send').disabled, true);
  assert.equal(h.node('composer-hint').textContent, '65,538 of 65,536 bytes. Shorten the message to send it.');
  h.node('message').dispatch('keydown', { key: 'Enter', ctrlKey: true }); await flush();
  type(h, 'left\0right');
  assert.equal(h.node('send').disabled, true); assert.match(h.node('composer-hint').textContent, /NUL character \(U\+0000\)/);
  h.node('composer').dispatch('submit'); await flush();
  assert.equal(h.requests('panel_send').length, 0);
  assert.equal(h.node('message').value, 'left\0right');
  type(h, 'left\uD800right');
  assert.equal(h.node('send').disabled, true); assert.match(h.node('composer-hint').textContent, /incomplete Unicode character/);
});

test('A07: an incoming and an outgoing message with the same ID both show, and only the outgoing one settles a send', async () => {
  const h = await live();
  await h.choose('a', [record('same', 'Outgoing text'), record('same', 'Incoming text', { direction: 'to_codex', created_at: 2000 })], { warnings: ['Some Claude replies could not be read.'] });
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['Outgoing text', 'Incoming text']);
  assert.match(h.node('alert-text').textContent, /Some Claude replies could not be read\./);
  await h.choose('b', [record('x', 'Reply X', { direction: 'to_codex', created_at: 2000 })], { has_more: true, next_cursor: 'older' });
  timelineButton(h, 'Load earlier messages').dispatch('click'); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'b', messages: [record('x', 'Sent X')], has_more: false, next_cursor: null }); await flush();
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['Sent X', 'Reply X']);
  type(h, 'Pending'); h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1); const id = send.message.params.arguments.message_id;
  h.emit({ jsonrpc: '2.0', id: send.message.id, error: { message: 'Lost.' } }); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'b', messages: [record(id, 'Same ID from Claude', { direction: 'to_codex' })], has_more: false, next_cursor: null }); await flush();
  assert.equal(h.node('send').disabled, true, 'An incoming row with the same ID does not settle the send.');
});

test('A08 and V06: a definite refusal keeps the draft, names the reason and one recovery step, and the next send reuses its ID', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Hello');
  h.node('composer').dispatch('submit'); await flush();
  const first = h.requests('panel_send').at(-1); const id = first.message.params.arguments.message_id;
  h.result(first, errorResult('Message not sent. Claude session is not live.', { delivered: false, retry: 'after_fix', reason: 'target_unavailable' })); await flush();
  assert.equal(h.node('send').disabled, false); assert.equal(h.node('message').value, 'Hello');
  assert.equal(h.node('alert-text').textContent, 'Not sent. The Claude Code inbox is unavailable. Check its Peer address in Claude Code, then refresh the list. The draft is kept.');
  assert.ok(alertButton(h, 'Refresh list'));
  assert.equal(descendants(h.node('timeline')).filter(node => node.className.startsWith('notice-detail')).length, 0);
  h.node('composer').dispatch('submit'); await flush();
  const second = h.requests('panel_send').at(-1); assert.equal(second.message.params.arguments.message_id, id);
  // A 1.0 server reports only the failed status and its error text.
  h.reply(second, { delivery: delivery(id, 'Hello', { status: 'failed', error: 'Claude Code refused the frame.' }), manual: true, notice_status: 'pending' }); await flush();
  assert.equal(h.node('alert-text').textContent, 'Not sent. The send failed before Claude Code took it. Claude Code refused the frame. Send again. The draft is kept.');
  assert.equal(h.node('send').disabled, false);
  type(h, 'Hello again'); h.node('composer').dispatch('submit'); await flush();
  const third = h.requests('panel_send').at(-1); assert.notEqual(third.message.params.arguments.message_id, id, 'Changed text gets a new ID.');
  h.result(third, { isError: true, content: [{ type: 'text', text: 'Message not sent. message has an unsupported control.' }],
    _meta: { 'bridge-claude-codex/outcome': { outcome: { delivered: false, retry: 'after_fix', reason: 'invalid_argument' } } } }); await flush();
  assert.equal(h.node('alert-text').textContent, 'Not sent. The bridge refused the message. message has an unsupported control. Correct it, then send again. The draft is kept.');
});

test('P05: an unchanged or growing history reuses the shown rows, and only a few conversations keep their pages', async () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({ session_id: `s${index}`, title: `Session ${index}`, cwd: `C:/p/${index}`, live: true, last_contact_at: 1000 + index, last_activity_at: 1000 + index }));
  const h = await live(undefined, sessions);
  const rows = [record('one', 'One'), record('two', 'Two', { created_at: 2000 })];
  await h.choose('s0', rows);
  const before = bubbles(h);
  const poll = async messages => { h.intervals[0](); await flush(); h.result(h.requests('bridge_panel').at(-1), launcher(sessions)); await flush();
    h.reply(h.requests('panel_history').at(-1), { session_id: 's0', messages, has_more: false, next_cursor: null }); await flush(); };
  await poll(rows);
  assert.ok(bubbles(h).every((node, index) => node === before[index]));
  await poll([...rows, record('three', 'Three', { created_at: 3000 })]);
  const after = bubbles(h); assert.equal(after.length, 3); assert.equal(after[0], before[0]); assert.equal(after[1], before[1]);
  for (let index = 1; index < 8; index++) await h.choose(`s${index}`);
  const loads = h.requests('panel_history').length;
  await h.choose('s3'); assert.equal(h.requests('panel_history').length, loads, 'A recent conversation is served from memory.');
  await h.choose('s0'); assert.equal(h.requests('panel_history').length, loads + 1, 'The least recent conversation was released and loads again.');
});

test('LC09: "Yesterday" is the previous calendar day across a daylight-saving change', async t => {
  const zone = process.env.TZ; process.env.TZ = 'America/New_York';
  t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  const now = new Date(2026, 2, 9, 0, 30).getTime();
  const h = await live(harness('', { now }));
  await h.choose('a', [record('sunday', 'Sent the day the clocks changed', { created_at: new Date(2026, 2, 8, 12, 0).getTime() }),
    record('monday', 'Sent after midnight', { created_at: new Date(2026, 2, 9, 0, 10).getTime() })]);
  assert.deepEqual(texts(h, 'day'), ['Yesterday', 'Today']);
});

test('V03, V10, A10: the composer names both destinations, a handoff is not called arrival, and look-alike rows show their exact ID', async () => {
  const twin = { session_id: 'twin-0000-1111', title: 'Bridge interface', cwd: 'C:/projects/bridge', live: true, last_contact_at: 900, last_activity_at: 900 };
  const h = await live(undefined, [...panel.sessions, twin]);
  const row = id => h.node('chat-list').children.find(node => node.dataset.sessionId === id);
  assert.match(row('twin-0000-1111').textContent, /Open · twin-000 · /); assert.match(row('a').textContent, /Open · a · /);
  h.node('tab-all').dispatch('click');
  assert.doesNotMatch(h.node('chat-list').textContent, /Archived/); assert.match(row('c').textContent, /Not open/);
  h.node('search').value = 'twin-0000'; h.node('search').dispatch('input');
  assert.deepEqual(h.node('chat-list').children.map(node => node.dataset.sessionId), ['twin-0000-1111']);
  await h.choose('twin-0000-1111');
  assert.equal(h.node('conversation-id').textContent, 'ID twin-0000-1111');
  assert.equal(h.node('composer-dest').textContent, 'To “Bridge interface” in Claude Code');
  assert.match(html, /id="copy-disclosure">A copy of the full text goes to this Codex chat/);
  type(h, 'Hello'); h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1);
  h.reply(send, { delivery: delivery(send.message.params.arguments.message_id, 'Hello', { manual: true, to: { app: 'claude', id: twin.session_id } }), manual: true, notice_status: 'submitted' }); await flush();
  const meta = descendants(h.node('timeline')).find(node => node.className === 'message-meta');
  assert.match(meta.textContent, /Handed to Claude Code/); assert.match(meta.title, /not a read receipt/);
  assert.doesNotMatch(descendants(h.node('timeline')).map(node => node._text).join(' '), /delivered|arrived/i);
  assert.ok(texts(h, 'notice-detail').includes('Copy posted in this Codex chat'));
});

test('owner change: once the Codex context changes, sends and owner copies stay blocked until the panel is reopened', async () => {
  const h = await live();
  await h.choose('a', [record('safe', 'Handed text', { manual: true, notice_status: 'failed', notice_retryable: true })]);
  type(h, 'Draft');
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: launcher(panel.sessions, { owner: 'different-owner' }) }); await flush();
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: launcher() }); await flush();
  assert.equal(h.node('send').disabled, true); assert.match(h.node('connection-error').textContent, /Codex context changed/);
  const retry = descendants(h.node('timeline')).find(node => node.textContent === 'Post the copy again');
  assert.equal(retry.disabled, true); retry.dispatch('click');
  h.node('message').dispatch('keydown', { key: 'Enter', ctrlKey: true }); h.node('composer').dispatch('submit'); await flush();
  assert.equal(h.requests('panel_retry_notice').length, 0); assert.equal(h.requests('panel_send').length, 0);
});

test('C3 handoff: the panel follows the catalog continuation, offers more archived conversations, and keeps rows a partial poll did not cover', async () => {
  const h = harness();
  const archived = page => ({ session_id: `old-${page}`, title: `Older ${page}`, cwd: 'C:/old', live: false, last_contact_at: null, last_activity_at: 100 + page });
  const olderRows = () => h.node('chat-list').children.filter(node => /^old-/.test(node.dataset.sessionId ?? '')).length;
  h.emit({ jsonrpc: '2.0', id: h.outgoing[0].message.id, result: { protocolVersion: '2026-01-26' } }); await flush();
  h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: launcher(panel.sessions, { cursor: 'n1',
    warnings: ['The catalog scan is incomplete. Continue discovery to search more archived Claude conversations.'] }) }); await flush();
  for (let page = 1; page <= 5; page++) {
    const request = h.requests('bridge_panel').at(-1);
    assert.deepEqual(request.message.params.arguments, { cursor: `n${page}` });
    h.result(request, launcher([...panel.sessions, archived(page)], { cursor: `n${page + 1}` })); await flush();
  }
  await h.bootstrap;
  h.node('tab-all').dispatch('click');
  assert.equal(olderRows(), 5);
  assert.equal(h.node('catalog-more').hidden, false); assert.doesNotMatch(h.node('list-note').textContent, /Continue discovery/);
  h.node('catalog-more').dispatch('click'); await flush();
  const more = h.requests('bridge_panel').at(-1); assert.deepEqual(more.message.params.arguments, { cursor: 'n6' });
  h.result(more, launcher([...panel.sessions, archived(6)])); await flush();
  assert.equal(olderRows(), 6); assert.equal(h.node('catalog-more').hidden, true);
  h.intervals[0](); await flush(); h.result(h.requests('bridge_panel').at(-1), launcher(panel.sessions, { cursor: 'n1' })); await flush();
  assert.equal(olderRows(), 6, 'A poll of page one keeps rows from later pages.');
  h.intervals[0](); await flush(); h.result(h.requests('bridge_panel').at(-1), launcher(panel.sessions.filter(chat => chat.session_id !== 'd'))); await flush();
  assert.equal(olderRows(), 0, 'A complete catalog drops rows it no longer lists.');
  assert.equal(h.node('chat-list').children.some(node => node.dataset.sessionId === 'd'), false);
});

test('C3 handoff: an unread history page keeps the shown rows and the older-page position, and Retry asks again', async () => {
  const h = await live();
  await h.choose('a', [record('one', 'One'), record('two', 'Two', { created_at: 2000 })], { has_more: true, next_cursor: 'p2' });
  h.node('refresh').dispatch('click'); await flush(); h.result(h.requests('bridge_panel').at(-1), launcher()); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [], incomplete: true, has_more: false, next_cursor: null, warnings: ['Claude history could not be read.'] }); await flush();
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['One', 'Two']);
  assert.equal(h.node('alert-text').textContent, 'Part of this history could not be read; showing what was loaded. Claude history could not be read.');
  alertButton(h, 'Retry').dispatch('click'); await flush();
  // A 1.0 server sends the same page without the flag.
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [], has_more: false, next_cursor: null, warnings: ['Claude history could not be read.'] }); await flush();
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['One', 'Two']);
  timelineButton(h, 'Load earlier messages').dispatch('click'); await flush();
  const older = h.requests('panel_history').at(-1); assert.equal(older.message.params.arguments.cursor, 'p2');
  h.reply(older, { session_id: 'a', messages: [], incomplete: true, has_more: true, next_cursor: 'p2', warnings: [] }); await flush();
  timelineButton(h, 'Retry earlier messages').dispatch('click'); await flush();
  assert.equal(h.requests('panel_history').at(-1).message.params.arguments.cursor, 'p2');
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [record('zero', 'Zero', { created_at: 500 })], has_more: false, next_cursor: null }); await flush();
  assert.deepEqual(bubbles(h).map(node => node.textContent), ['Zero', 'One', 'Two']);
});

test('C3 handoff and Q04: each owner-copy state has its own line, and only a safe one offers to post the copy', async () => {
  const h = await live();
  await h.choose('a', [
    record('full', 'Ledger full', { manual: true, notice_status: 'failed', notice_retryable: false, notice_reason: 'state_unavailable', notice_omitted: true }),
    record('stopped', 'Sender stopped', { manual: true, notice_status: 'pending', notice_retryable: true }),
    record('busy', 'Codex busy', { manual: true, notice_status: 'failed', notice_retryable: true, notice_reason: 'target_busy' }),
  ]);
  const lines = () => descendants(h.node('timeline')).filter(node => node.className.startsWith('notice-detail')).map(node => node.textContent);
  assert.deepEqual(lines(), [
    'No copy in this Codex chat: the notice ledger shared with older bridge versions is full. Do not resend the message to Claude Code.',
    'No copy in this Codex chat yet: the send stopped before posting it.',
    'Copy for this Codex chat not posted: Codex was busy.']);
  const buttons = descendants(h.node('timeline')).filter(node => node.tagName === 'button').map(node => node.textContent);
  assert.deepEqual(buttons, ['Post the copy now', 'Post the copy again']);
  descendants(h.node('timeline')).find(node => node.textContent === 'Post the copy now').dispatch('click'); await flush();
  const retry = h.requests('panel_retry_notice').at(-1); assert.deepEqual(retry.message.params.arguments, { session_id: 'a', message_id: 'stopped' });
  h.reply(retry, { delivery: delivery('stopped', 'Sender stopped', { manual: true }), manual: true, notice_status: 'submitted', notice_retryable: false,
    notice_outcome: { delivered: true, retry: 'no', reason: 'settlement_failed' } }); await flush();
  assert.equal(lines()[1], 'Copy posted in this Codex chat; the bridge could not record that. Do not post it again.');
  assert.equal(h.requests('panel_send').length, 0);
});

test('C3 handoff and E01: a send result names the Claude handoff and the skipped or unrecorded owner copy separately', async () => {
  const h = await live(); await h.choose('a'); type(h, 'At capacity');
  h.node('composer').dispatch('submit'); await flush();
  let send = h.requests('panel_send').at(-1);
  h.reply(send, { delivery: delivery(send.message.params.arguments.message_id, 'At capacity', { manual: true }), manual: true, notice_status: 'failed', notice_retryable: false,
    notice_omitted: true, outcome: { delivered: true, retry: 'no', reason: 'submitted' }, notice_outcome: { delivered: false, retry: 'no', reason: 'state_unavailable' } }); await flush();
  assert.equal(h.node('message').value, ''); assert.equal(h.node('conversation-alert').hidden, true);
  assert.ok(texts(h, 'notice-detail warning').includes('No copy in this Codex chat: the notice ledger shared with older bridge versions is full. Do not resend the message to Claude Code.'));
  type(h, 'Unrecorded'); h.node('composer').dispatch('submit'); await flush();
  send = h.requests('panel_send').at(-1);
  h.reply(send, { delivery: delivery(send.message.params.arguments.message_id, 'Unrecorded', { manual: true }), manual: true, notice_status: 'submitted',
    outcome: { delivered: true, retry: 'no', reason: 'settlement_failed' }, notice_outcome: { delivered: true, retry: 'no', reason: 'settlement_failed' } }); await flush();
  const row = descendants(h.node('timeline')).filter(node => node.className === 'message-row outgoing').at(-1);
  assert.match(row.textContent, /Handed to Claude Code.*Not recorded by the bridge; do not send it again/);
  assert.match(row.textContent, /Copy posted in this Codex chat; the bridge could not record that\. Do not post it again\./);
});

test('version skew: a 1.0 launcher result without UI metadata lists every conversation; a 1.1 result whose metadata was dropped asks once', async () => {
  const start = async (h, params) => { h.emit({ jsonrpc: '2.0', id: h.outgoing[0].message.id, result: { protocolVersion: '2026-01-26' } }); await flush();
    h.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params }); await flush(); };
  const old = harness(); await start(old, { structuredContent: { ...panel, composer_enter_behavior: 'enter' } }); await old.bootstrap;
  old.node('tab-all').dispatch('click');
  assert.equal(old.node('chat-list').children.length, 4); assert.equal(old.requests('bridge_panel').length, 0);
  const dropped = harness(); await start(dropped, { structuredContent: launcher().structuredContent });
  assert.equal(dropped.requests('bridge_panel').length, 1);
  dropped.result(dropped.requests('bridge_panel').at(-1), launcher()); await flush(); await dropped.bootstrap;
  dropped.node('tab-all').dispatch('click');
  assert.equal(dropped.node('chat-list').children.length, 4);
});

test('PN01/PN02/PN03: a late handoff survives weaker history and a definite unposted copy never says posting', async () => {
  const h = await live(); await h.choose('a'); type(h,'Late text'); h.node('composer').dispatch('submit'); await flush();
  const send=h.requests('panel_send').at(-1), id=send.message.params.arguments.message_id;
  for (const timer of [...h.timers.values()]) if (timer.ms <= 25000) timer.callback();
  h.reply(send, {delivery: delivery(id,'Late text'), manual:true, notice_status:'pending', notice_retryable:false,
    outcome:{delivered:true,retry:'no',reason:'settlement_failed'},notice_outcome:{delivered:false,retry:'after_fix',reason:'state_unavailable'}}); await flush();
  h.reply(h.requests('panel_history').at(-1), {session_id:'a',messages:[record(id,'Late text',{manual:true,status:'uncertain',notice_status:'pending'})],warnings:[]}); await flush();
  assert.equal(h.node('message').value,''); const timeline=h.node('timeline').textContent;
  assert.match(timeline,/Handed to Claude Code/); assert.match(timeline,/Copy not posted.*state/); assert.doesNotMatch(timeline,/Posting a copy|Handoff not confirmed/);
});

test('PN04/CA01/EC03: retry the refused revision under its ID, keep the edited draft and repair the verifier first', async () => {
  const h = await live(); await h.choose('a'); type(h,'First'); h.node('composer').dispatch('submit'); await flush();
  const send=h.requests('panel_send').at(-1), id=send.message.params.arguments.message_id; type(h,'Different draft');
  h.reply(send,{delivery:delivery(id,'First',{status:'failed'}),manual:true,notice_status:'pending',outcome:{delivered:false,retry:'after_fix',reason:'identity_check_unavailable'}}); await flush();
  assert.ok(bubbles(h).some(n=>n.textContent==='First')); assert.match(h.node('timeline').textContent,/process-query access/);
  timelineButton(h,'Retry this text').dispatch('click'); await flush(); const retry=h.requests('panel_send').at(-1);
  assert.deepEqual(retry.message.params.arguments,{session_id:'a',message:'First',message_id:id,retry_failed:true});
  h.reply(retry,{delivery:delivery(id,'First'),manual:true,notice_status:'submitted',outcome:{delivered:true,retry:'no',reason:'submitted'}}); await flush();
  assert.equal(h.node('message').value,'Different draft'); h.node('composer').dispatch('submit'); await flush(); assert.notEqual(h.requests('panel_send').at(-1).message.params.arguments.message_id,id);
});

test('PN05: only the original owner can restore frozen drafts; the frozen view supports copying, not sending', async () => {
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const h=await live(harness('',{storage})); await h.choose('a'); type(h,'Private draft');
  h.emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:launcher(panel.sessions,{owner:'different-owner'})}); await flush();
  assert.equal(h.node('message').disabled,false); assert.equal(h.node('message').readOnly,true); assert.ok(alertButton(h,'Select draft')); assert.equal(h.node('send').disabled,true);
  const other=harness('',{storage}); other.emit({jsonrpc:'2.0',id:other.outgoing[0].message.id,result:{protocolVersion:'2026-01-26'}}); await flush();
  other.emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:launcher(panel.sessions,{owner:'different-owner'})}); await flush(); await other.choose('a'); assert.equal(other.node('message').value,'');
  const back=await live(harness('',{storage})); await back.choose('a'); assert.equal(back.node('message').value,'Private draft');
});

test('PN07/PN09/TL05: an explicit setting withdrawal restores newline, and teardown fences even synthetic submit', async () => {
  const h=await live(); await h.choose('a'); type(h,'Draft'); const settings=params=>h.emit({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params});
  settings({composer_enter_behavior:'enter'}); settings({theme:'light'}); assert.match(h.node('composer-hint').textContent,/Enter sends/);
  settings({composer_enter_behavior:null}); assert.equal(h.node('message').dispatch('keydown',{key:'Enter'}),false); assert.equal(h.requests('panel_send').length,0);
  h.emit({jsonrpc:'2.0',id:94,method:'ui/resource-teardown',params:{}}); assert.equal(h.node('send').disabled,true); h.node('composer').dispatch('submit'); await flush(); assert.equal(h.requests('panel_send').length,0);
});

test('PN10: an older-page warning remains beside surviving rows when the reader reaches the end', async () => {
  const h=await live(); await h.choose('a',[record('n','New')],{next_cursor:'older',has_more:true}); timelineButton(h,'Load earlier messages').dispatch('click'); await flush();
  h.reply(h.requests('panel_history').at(-1),{session_id:'a',messages:[record('o','Old')],warnings:['An older record needs attention.'],next_cursor:null,has_more:false}); await flush();
  assert.ok(bubbles(h).some(n=>n.textContent==='Old')); assert.match(h.node('alert-text').textContent,/older record needs attention/);
});

test('EC02: a definite inspect-only conflict cannot turn the identical text into a fresh send', async () => {
  const h=await live(); await h.choose('a'); type(h,'Same'); h.node('composer').dispatch('submit'); await flush(); const send=h.requests('panel_send').at(-1);
  h.result(send,errorResult('Already used',{delivered:false,retry:'inspect',reason:'id_conflict'})); await flush(); assert.ok(alertButton(h,'Check again')); h.node('composer').dispatch('submit');
  await checkHistoryOnly(h,[record(send.message.params.arguments.message_id,'Same',{manual:false})]); assert.equal(h.node('send').disabled,true); assert.equal(h.uuidCount(),1);
});

test('PN02: confirming a receipt once does not let a later read downgrade its primary or its posted copy', async()=>{
  const h=await live();await h.choose('a');type(h,'Exact');h.node('composer').dispatch('submit');await flush();
  const send=h.requests('panel_send').at(-1),id=send.message.params.arguments.message_id;
  h.reply(send,{delivery:delivery(id,'Exact'),manual:true,notice_status:'submitted',outcome:{delivered:true,reason:'submitted',retry:'no'},notice_outcome:{delivered:true,reason:'submitted',retry:'no'}});await flush();
  const page=row=>({session_id:'a',messages:[record(id,'Exact',{manual:true,...row})],warnings:[]});
  h.reply(h.requests('panel_history').at(-1),page({notice_status:'submitted'}));await flush();
  h.intervals[0]();await flush();h.result(h.requests('bridge_panel').at(-1),launcher());await flush();
  h.reply(h.requests('panel_history').at(-1),page({status:'sending',notice_status:'pending'}));await flush();
  assert.match(h.node('timeline').textContent,/Handed to Claude Code/);assert.match(h.node('timeline').textContent,/Copy posted in this Codex chat/);
});

test('PN09: teardown with an already-dispatched send permits its receipt but no further host calls',async()=>{
  const h=await live();await h.choose('a');type(h,'Dispatched');h.node('composer').dispatch('submit');await flush();const first=h.requests('panel_send').at(-1);
  h.emit({jsonrpc:'2.0',method:'ui/resource-teardown',id:'bye',params:{}});const before=h.outgoing.length;
  h.reply(first,{delivery:delivery(first.message.params.arguments.message_id,'Dispatched'),manual:true,notice_status:'submitted'});await flush();
  type(h,'Next');h.node('composer').dispatch('submit');await flush();assert.equal(h.outgoing.length,before);assert.equal(h.node('send').disabled,true);assert.match(h.node('timeline').textContent,/Handed to Claude Code/);
});

test('PN03/SP06: exact history can authorize only the owner copy and the next failure keeps its repair', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Try once'); h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1), id = send.message.params.arguments.message_id;
  const reply = (reason, retryable, status) => ({ delivery: delivery(id, 'Try once'), manual: true, notice_status: status,
    notice_retryable: retryable, ...(retryable ? { notice_retry_action: 'panel_retry_notice' } : {}),
    outcome: { delivered: true, retry: 'no', reason: 'submitted' }, notice_outcome: { delivered: false, reason, retry: 'after_fix' } });
  h.reply(send, reply('state_unavailable', false, 'pending')); await flush();
  assert.match(h.node('timeline').textContent, /Copy not posted.*Restore write access/); assert.equal(timelineButton(h, 'Post the copy now'), undefined);
  h.reply(h.requests('panel_history').at(-1), { session_id: 'a', messages: [record(id, 'Try once', { manual: true, notice_status: 'pending', notice_retryable: true })] }); await flush();
  assert.match(h.node('timeline').textContent, /Copy not posted.*Restore write access/);
  timelineButton(h, 'Post the copy now').dispatch('click'); await flush();
  const retry = h.requests('panel_retry_notice').at(-1); assert.deepEqual(retry.message.params.arguments, { session_id: 'a', message_id: id });
  h.reply(retry, reply('protocol_incompatible', true, 'failed')); await flush();
  assert.match(h.node('timeline').textContent, /Copy not posted.*target-host support/); assert.ok(timelineButton(h, 'Post the copy again')); assert.equal(h.requests('panel_send').length, 1);
});

test('R3P02: a later copy attempt replaces the previous refusal without offering another post', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Original'); h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1), id = send.message.params.arguments.message_id;
  h.reply(send, { delivery: delivery(id, 'Original'), manual: true, notice_status: 'failed', notice_retryable: true,
    notice_outcome: { delivered: false, reason: 'request_rejected', retry: 'after_fix' } }); await flush();
  const history = status => ({ session_id: 'a', messages: [record(id, 'Original', { manual: true, notice_status: status, notice_retryable: false })] });
  h.reply(h.requests('panel_history').at(-1), history('pending')); await flush();
  assert.match(h.node('timeline').textContent, /Posting a copy/); assert.doesNotMatch(h.node('timeline').textContent, /Copy not posted/);
  h.node('refresh').dispatch('click'); await flush(); h.result(h.requests('bridge_panel').at(-1), launcher()); await flush();
  h.reply(h.requests('panel_history').at(-1), history('uncertain')); await flush();
  assert.match(h.node('timeline').textContent, /may not have been posted.*Check this chat/);
  assert.equal(timelineButton(h,'Post the copy again'), undefined); assert.equal(h.requests('panel_retry_notice').length, 0);
});

test('R3P02: a busy copy-only retry does not hide a newer durable claim on the pending slot', async () => {
  const h = await live(), row = record('copy', 'Original', { manual:true, notice_status:'pending', notice_retryable:true });
  await h.choose('a', [row]); timelineButton(h,'Post the copy now').dispatch('click'); await flush();
  h.result(h.requests('panel_retry_notice').at(-1), errorResult('Busy.', { delivered:false, reason:'server_busy', retry:'same_id' })); await flush();
  h.reply(h.requests('panel_history').at(-1), { session_id:'a', messages:[{ ...row, notice_retryable:false, notice_claimed:true }] }); await flush();
  assert.match(h.node('timeline').textContent, /Posting a copy/); assert.doesNotMatch(h.node('timeline').textContent, /could not be posted/);
  assert.equal(timelineButton(h,'Post the copy now'), undefined); assert.equal(h.requests('panel_send').length, 0);
});

test('R3P03: an offline catalog notification disables the refused row and replaces send-again guidance', async () => {
  const h = await live(); await h.choose('a'); type(h,'Original'); h.node('composer').dispatch('submit'); await flush();
  h.result(h.requests('panel_send').at(-1), errorResult('Busy.', { delivered:false, retry:'same_id', reason:'target_busy' })); await flush();
  assert.equal(Boolean(timelineButton(h,'Retry this text').disabled), false);
  const notify = sessions => h.emit({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:launcher(sessions) });
  notify(panel.sessions.map(chat => ({...chat, live:false}))); await flush();
  assert.equal(timelineButton(h,'Retry this text').disabled, true);
  assert.match(h.node('alert-text').textContent, /open this conversation/i); assert.doesNotMatch(h.node('timeline').textContent, /Send again/i);
  timelineButton(h,'Retry this text').dispatch('click'); await flush(); assert.equal(h.requests('panel_send').length, 1);
  notify(panel.sessions); await flush(); assert.equal(Boolean(timelineButton(h,'Retry this text').disabled), false);
});

test('PN03: an initial protocol refusal names the copy repair, not an unconditional retry or a raw diagnostic', async () => {
  const h = await live(); await h.choose('a'); type(h, 'Exact'); h.node('composer').dispatch('submit'); await flush();
  const send = h.requests('panel_send').at(-1), id = send.message.params.arguments.message_id;
  h.reply(send, { delivery: delivery(id, 'Exact'), manual: true, notice_status: 'failed', notice_retryable: true,
    notice_error: 'Private fixture diagnostic', notice_retry_action: 'panel_retry_notice', notice_outcome: { delivered: false, reason: 'protocol_incompatible', retry: 'after_fix' } }); await flush();
  assert.match(h.node('timeline').textContent, /target-host support/); assert.ok(timelineButton(h, 'Post the copy again')); assert.doesNotMatch(h.node('timeline').textContent, /Private fixture diagnostic/);
});

test('CA03/EC07: rejected or superseded older cursors restart from an overlapping first page without losing the draft', async () => {
  for (const change of ['typed rejection', '1.0 rejection', 'order changed']) {
    const h = await live(); await h.choose('a', [record('x', 'Newest')], { has_more: true, next_cursor: 'obsolete' }); type(h, 'Keep draft');
    if (change !== 'order changed') {
      timelineButton(h, 'Load earlier messages').dispatch('click'); await flush();
      const older = h.requests('panel_history').at(-1); assert.equal(older.message.params.arguments.cursor, 'obsolete');
      h.result(older, change === '1.0 rejection' ? { isError: true, content: [{ type: 'text', text: 'Invalid conversation cursor.' }] }
        : errorResult('Restart without cursor.', { delivered: false, retry: 'after_fix', reason: 'invalid_argument' })); await flush();
      assert.equal(timelineButton(h, 'Retry earlier messages'), undefined);
    }
    h.node('refresh').dispatch('click'); await flush(); const catalog = launcher();
    if (change === 'order changed') catalog._meta[CATALOG].history_order = 'commit';
    h.result(h.requests('bridge_panel').at(-1), catalog); await flush();
    const newest = h.requests('panel_history').at(-1); assert.equal(newest.message.params.arguments.cursor, undefined);
    h.reply(newest, { session_id: 'a', messages: [record('x', 'Newest')], next_cursor: 'valid', has_more: true }); await flush();
    timelineButton(h, 'Load earlier messages').dispatch('click'); await flush(); assert.equal(h.requests('panel_history').at(-1).message.params.arguments.cursor, 'valid');
    assert.equal(h.node('message').value, 'Keep draft'); assert.equal(h.requests('panel_send').length, 0);
  }
});
