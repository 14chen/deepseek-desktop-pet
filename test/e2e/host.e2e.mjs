/**
 * End-to-end verification of the desktop-pet host plugin.
 *
 * This loads the real `src/host/index.js` into the miniature Cordis host from
 * `test/harness.mjs` and drives it exactly as DSH would: emitting agent events,
 * calling the registered tools, and making real HTTP requests against the
 * routes the plugin mounts on a real socket.
 *
 * Nothing is stubbed inside the plugin itself - the store writes real files, the
 * hub runs its real throttling, and the HTTP layer is a real server.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HarnessContext, assert, assertEqual, assertMatch, waitFor } from '../harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');

/** The token every test host is configured with, so the LAN gate is testable. */
const TEST_TOKEN = 'test-token-0123456789abcdef';

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  \u2713 ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  \u2717 ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
  }
}

/**
 * Issue a request with a forged Host header. `fetch` normalises Host, so the
 * LAN gate can only be exercised with the raw client.
 */
function rawRequest(base, route, hostHeader) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: route,
      method: 'GET',
      headers: { host: hostHeader },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

/** A fresh host for one test, with an isolated state directory. */
async function createHost(config = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-e2e-'));
  const ctx = new HarnessContext('test');
  const webServer = ctx.createWebServer();
  const account = ctx.createAccount();

  ctx.provide('webServer', webServer);
  ctx.provide('tools', ctx.createTools());
  ctx.provide('commands', ctx.createCommands());
  ctx.provide('deepseekAccount', account);

  const module = await import(`${new URL(`file://${ROOT.replace(/\\/g, '/')}/src/host/index.js`).href}`);
  module.apply(ctx, {
    stateDir,
    webToken: TEST_TOKEN,
    desktopEnabled: false,
    quotaPollSeconds: 0,
    ...config,
  });

  await webServer.listen();
  const base = `http://127.0.0.1:${webServer.port}`;

  return {
    ctx,
    webServer,
    account,
    stateDir,
    base,
    token: () => TEST_TOKEN,
    /** Read the live state through the plugin's own HTTP surface. */
    async state() {
      const response = await fetch(`${base}/pet/api/state`);
      assertEqual(response.status, 200, 'GET /pet/api/state should succeed');
      return response.json();
    },
    async post(type, payload = {}) {
      const response = await fetch(`${base}/pet/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, ...payload }),
      });
      assertEqual(response.status, 200, `POST ${type} should succeed`);
      return response.json();
    },
    async tool(name) {
      const definition = ctx.registeredTools.get(name);
      assert(definition, `tool ${name} should be registered`);
      return definition;
    },
    async close() {
      ctx.dispose();
      await webServer.close();
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch { /* windows may hold a handle briefly */ }
    },
  };
}

// ---------------------------------------------------------------------------

const host = await createHost();

// --- 1. Registration ------------------------------------------------------
await check('host plugin exports the Cordis contract', async () => {
  const module = await import(`file://${ROOT.replace(/\\/g, '/')}/src/host/index.js`);
  assertEqual(module.name, 'desktop-pet', 'name');
  assert(Array.isArray(module.inject), 'inject must be an array');
  assertEqual(module.inject, ['timer'], 'inject');
  assertEqual(typeof module.apply, 'function', 'apply');
});

await check('registers all five agent tools', async () => {
  const names = [...host.ctx.registeredTools.keys()].sort();
  assertEqual(names, ['pet_control', 'pet_notify', 'pet_quota', 'pet_status', 'pet_todo'], 'tool names');
});

await check('registers the /pet slash command', async () => {
  const command = host.ctx.registeredCommands.get('pet');
  assert(command, '/pet must be registered');
  assertEqual(command.name, 'pet', 'command name');
  assert(command.description.length > 0, 'description must be non-empty');
  assert(command.input?.hint?.length > 0, 'input.hint must be non-empty');
});

await check('every tool exposes a valid schema and renderer', async () => {
  for (const [name, definition] of host.ctx.registeredTools) {
    assertEqual(typeof definition.description, 'string', `${name}.description`);
    assert(definition.description.length > 20, `${name}.description should be useful`);
    assertEqual(definition.parameters.type, 'object', `${name}.parameters.type`);
    assertEqual(definition.parameters.additionalProperties, false, `${name}.parameters.additionalProperties`);
    assert(Array.isArray(definition.parameters.required), `${name}.parameters.required`);
    for (const required of definition.parameters.required) {
      assert(definition.parameters.properties[required], `${name}: required "${required}" must be declared`);
    }
    assert(definition.output?.schema, `${name}.output.schema`);
    assertEqual(typeof definition.output.render, 'function', `${name}.output.render`);
    assertEqual(typeof definition.execute, 'function', `${name}.execute`);
  }
});

await check('tool schemas survive JSON round-tripping', async () => {
  for (const [name, definition] of host.ctx.registeredTools) {
    const wire = JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output.schema,
    });
    const parsed = JSON.parse(wire);
    assertEqual(parsed.name, name, `${name} round-trip`);
  }
});

// --- 2. HTTP surface ------------------------------------------------------
await check('GET /pet/health answers without a token', async () => {
  const response = await fetch(`${host.base}/pet/health`);
  assertEqual(response.status, 200, 'health status');
  const body = await response.json();
  assertEqual(body.ok, true, 'health body');
  assertEqual(body.service, 'dsh-desktop-pet', 'health service');
});

await check('GET /pet/ serves the responsive page', async () => {
  const response = await fetch(`${host.base}/pet/`);
  assertEqual(response.status, 200, 'page status');
  assertMatch(response.headers.get('content-type'), /text\/html/, 'content type');
  const html = await response.text();
  assertMatch(html, /viewport-fit=cover/, 'uses the safe-area viewport');
  assertMatch(html, /prefers-color-scheme/, 'supports light and dark');
  assertMatch(html, /manifest\.webmanifest/, 'is installable');
  assertMatch(html, /id="bubble"/, 'has the speech bubble');
  assertMatch(html, /id="ringValue"/, 'has the quota ring');
});

await check('static assets are served with correct types', async () => {
  const expectations = [
    ['/pet/pet.css', /text\/css/],
    ['/pet/pet.js', /javascript/],
    ['/pet/embed.js', /javascript/],
    ['/pet/manifest.webmanifest', /manifest\+json/],
    ['/pet/assets/pet-128.png', /image\/png/],
  ];
  for (const [route, type] of expectations) {
    const response = await fetch(`${host.base}${route}`);
    assertEqual(response.status, 200, `${route} status`);
    assertMatch(response.headers.get('content-type'), type, `${route} type`);
  }
});

await check('path traversal is refused', async () => {
  for (const route of ['/pet/../../package.json', '/pet/assets/../../host/index.js']) {
    const response = await fetch(`${host.base}${route}`, { redirect: 'manual' });
    assert(response.status === 403 || response.status === 404, `${route} must not be served (got ${response.status})`);
  }
});

await check('a non-loopback request without the token is rejected', async () => {
  // `fetch` normalises the Host header, so the gate is exercised with a raw
  // request that can actually forge it.
  const status = await rawRequest(host.base, '/pet/api/state', '10.9.9.9:1234');
  assertEqual(status, 401, 'foreign host without a token');
});

await check('the LAN token authorises a foreign host', async () => {
  const token = host.token();
  assert(token && token.length > 10, 'the host exposes a token for LAN clients');
  const denied = await rawRequest(host.base, '/pet/api/state', '10.9.9.9:1234');
  assertEqual(denied, 401, 'still refused without it');
  const allowed = await rawRequest(host.base, `/pet/api/state?token=${encodeURIComponent(token)}`, '10.9.9.9:1234');
  assertEqual(allowed, 200, 'accepted with it');
});

await check('a wrong token is refused', async () => {
  const status = await rawRequest(host.base, '/pet/api/state?token=not-the-token', '10.9.9.9:1234');
  assertEqual(status, 401, 'wrong token');
});

await check('unknown routes return a JSON 404', async () => {
  const response = await fetch(`${host.base}/pet/definitely-not-here`);
  assertEqual(response.status, 404, 'status');
  const body = await response.json();
  assertEqual(body.ok, false, 'body');
});

// --- 3. State document ----------------------------------------------------
await check('the state document has every surface\'s expected shape', async () => {
  const state = await host.state();
  for (const key of ['v', 'ts', 'settings', 'pet', 'quota', 'activity', 'pending', 'toast', 'pomodoro', 'todos', 'plan', 'bridge']) {
    assert(key in state, `state.${key} must exist`);
  }
  assertEqual(state.pet.name, 'Deep', 'pet name');
  assertEqual(state.pet.level, 1, 'starting level');
  assert(state.pet.xpToNext > 0, 'xp curve must start above zero');
  assertEqual(state.quota.status, 'unknown', 'no reading yet');
  assert(state.bridge.webUrl.endsWith('/pet/'), 'the pet page URL is reported once the server is bound');
  assertEqual(state.bridge.webPort, host.webServer.port, 'the reported port matches the listener');
});

await check('settings merge plugin config over defaults', async () => {
  const state = await host.state();
  assertEqual(state.settings.quotaPollSeconds, 0, 'config override is applied');
  assertEqual(state.settings.pomodoroFocusMinutes, 25, 'default is preserved');
  assertEqual(state.settings.notifyOnTaskDone, true, 'default is preserved');
});

// --- 4. Interactions ------------------------------------------------------
await check('todo-add / toggle / remove / clear round-trip through HTTP', async () => {
  const added = await host.post('todo-add', { text: '写测试' });
  assertEqual(added.ok, true, 'add ok');
  let state = await host.state();
  assertEqual(state.todos.length, 1, 'one todo');
  assertEqual(state.todos[0].text, '写测试', 'todo text, including non-ASCII');
  assertEqual(state.todos[0].done, false, 'not done');

  const id = state.todos[0].id;
  await host.post('todo-toggle', { id });
  state = await host.state();
  assertEqual(state.todos[0].done, true, 'toggled');

  await host.post('todo-remove', { id });
  state = await host.state();
  assertEqual(state.todos.length, 0, 'removed');

  await host.post('todo-add', { text: 'a' });
  await host.post('todo-clear');
  state = await host.state();
  assertEqual(state.todos.length, 0, 'cleared');
});

await check('an empty todo is refused', async () => {
  const result = await host.post('todo-add', { text: '   ' });
  assertEqual(result.ok, false, 'must refuse blank text');
});

await check('stroking the pet grows affection and experience', async () => {
  const before = await host.state();
  await host.post('pet');
  const after = await host.state();
  assertEqual(after.pet.affection, before.pet.affection + 1, 'affection');
  assert(after.pet.totalPets > before.pet.totalPets, 'stroke counter');
  assert(after.pet.xp > before.pet.xp, 'experience');
});

await check('pomodoro start, report and stop', async () => {
  await host.post('pomodoro-start', { minutes: 1 });
  let state = await host.state();
  assertEqual(state.pomodoro.running, true, 'running');
  assertEqual(state.pomodoro.mode, 'focus', 'mode');
  assert(state.pomodoro.remainingMs > 0, 'remaining');

  await host.post('pomodoro-stop');
  state = await host.state();
  assertEqual(state.pomodoro.running, false, 'stopped');
});

await check('mute suppresses bubbles and unmute restores them', async () => {
  await host.post('mute');
  const muted = await host.post('notify', { text: 'should not appear' });
  assertEqual(muted.delivered, false, 'suppressed while muted');
  await host.post('unmute');
  const shown = await host.post('notify', { text: 'hello' });
  assertEqual(shown.delivered, true, 'delivered after unmute');
});

await check('an unknown action is rejected without throwing', async () => {
  const result = await host.post('definitely-not-an-action');
  assertEqual(result.ok, false, 'refused');
  assertMatch(result.message, /未知操作/, 'explains itself in the user\'s language');
});

// --- 5. Notifications -----------------------------------------------------
await check('a toast reaches the state document with its actions', async () => {
  const created = await host.post('notify', { text: '测试气泡', title: '标题', kind: 'question', sticky: true });
  const state = await host.state();
  assertEqual(state.toast.id, created.toastId, 'the newest bubble is current');
  assertEqual(state.toast.text, '测试气泡', 'toast text');
  assertEqual(state.toast.title, '标题', 'toast title');
  assertEqual(state.toast.kind, 'question', 'toast kind');
  assertEqual(state.toast.sticky, true, 'sticky');
  assert(state.toast.actions.length > 0, 'toast actions');

  await host.post('dismiss', { id: created.toastId });
  const dismissed = await host.state();
  assert(!dismissed.toasts.some((item) => item.id === created.toastId && !item.dismissed), 'the bubble is marked dismissed');
  assert(dismissed.toast?.id !== created.toastId, 'it is no longer the current bubble');
});

await check('dismissing reveals the next live bubble', async () => {
  await host.post('dismiss-all');
  const first = await host.post('notify', { text: '第一个', kind: 'info', sticky: true });
  const second = await host.post('notify', { text: '第二个', kind: 'info', sticky: true });
  let state = await host.state();
  assertEqual(state.toast.id, second.toastId, 'the newest is current');

  await host.post('dismiss', { id: second.toastId });
  state = await host.state();
  assertEqual(state.toast.id, first.toastId, 'the earlier still-live bubble is revealed');

  await host.post('dismiss', { id: first.toastId });
  state = await host.state();
  assertEqual(state.toast, null, 'and the stack ends empty');
});

await check('dismiss-all clears every bubble at once', async () => {
  await host.post('notify', { text: 'a', kind: 'info', sticky: true });
  await host.post('notify', { text: 'b', kind: 'info', sticky: true });
  await host.post('dismiss-all');
  const state = await host.state();
  assertEqual(state.toast, null, 'nothing is current');
  assertEqual(state.toasts.filter((item) => !item.dismissed).length, 0, 'nothing is left live');
});

await check('bubbles are recorded in the toast log', async () => {
  const state = await host.state();
  assert(state.toasts.length > 0, 'the log keeps history for the web timeline');
});

// --- 6. Agent events ------------------------------------------------------
await check('finishing a turn raises the completion bubble and awards xp', async () => {
  const before = await host.state();
  const session = {
    id: 'session-test',
    header: { id: 'session-test', cwd: 'F:\\devbox' },
    snapshotEvents: () => [],
  };
  const agent = { id: 'session-test', session };

  host.ctx.emit('agent/status', { agent, status: 'running' });
  await waitFor(async () => (await host.state()).activity.agentRunning, { label: 'running state' });

  host.ctx.emit('agent/status', { agent, status: 'idle' });
  const after = await waitFor(async () => {
    const state = await host.state();
    return state.activity.tasksToday > before.activity.tasksToday ? state : null;
  }, { label: 'completion recorded' });

  assertEqual(after.activity.tasksToday, before.activity.tasksToday + 1, 'task count');
  assertEqual(after.toast.kind, 'done', 'completion bubble');
  assertMatch(after.toast.text, /完成|搞定|收工|落地/, 'completion wording');
  assert(after.pet.xp >= before.pet.xp, 'experience awarded');
});

await check('a subagent finishing does not raise a completion bubble', async () => {
  const before = await host.state();
  const session = {
    id: 'session-child',
    header: { id: 'session-child', cwd: 'F:\\devbox', parentSession: 'session-test', origin: 'subagent' },
    snapshotEvents: () => [],
  };
  const agent = { id: 'session-child', session };
  host.ctx.emit('agent/status', { agent, status: 'running' });
  host.ctx.emit('agent/status', { agent, status: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = await host.state();
  assertEqual(after.activity.tasksToday, before.activity.tasksToday, 'no task counted for a subagent');
});

await check('a pending question is surfaced and the waterfall still resolves', async () => {
  const request = {
    questions: [{ id: 'q1', question: '要继续吗？', header: '确认', options: [{ label: '是' }, { label: '否' }] }],
    agent: { id: 'session-test', session: { id: 'session-test', header: { id: 'session-test' } } },
  };
  // The answerer deliberately stays open: in the real harness it waits for the
  // user, and the pending badge must be visible for exactly that window.
  let release;
  let answered = false;
  const waiting = new Promise((resolve) => { release = resolve; });
  const answer = host.ctx.waterfall('user-questions/request', request, async () => {
    answered = true;
    await waiting;
    return { answers: [{ id: 'q1', selected: ['是'] }] };
  });

  const pending = await waitFor(async () => {
    const state = await host.state();
    return state.pending.length > 0 ? state : null;
  }, { label: 'pending question recorded' });

  assertEqual(pending.pending[0].kind, 'question', 'pending kind');
  assertEqual(pending.pending[0].title, '确认', 'uses the header as the title');
  assertEqual(pending.toast.kind, 'question', 'question bubble');
  assertEqual(pending.toast.sticky, true, 'a blocking question must not auto-dismiss');

  // The observer must forward the chain, otherwise the real answerer never runs.
  assertEqual(answered, true, 'the downstream answerer must still be reached');
  release();
  const result = await answer;
  assertEqual(result.answers[0].selected[0], '是', 'the answer is passed through unchanged');

  await waitFor(async () => (await host.state()).pending.length === 0, { label: 'pending cleared after the answer' });
});

await check('a question observer cannot veto the chain', async () => {
  // A malformed payload must not stop the observer from forwarding `next()`.
  const request = { questions: null, agent: { id: 'session-test', session: { id: 'session-test', header: {} } } };
  const result = await host.ctx.waterfall(
    'user-questions/request',
    request,
    async () => ({ answers: [{ id: 'x', selected: ['ok'] }] }),
  );
  assertEqual(result.answers[0].selected[0], 'ok', 'the answerer still runs');
});

await check('a pending approval is surfaced and forwarded', async () => {
  const request = {
    agent: { id: 'session-test', session: { id: 'session-test', header: { id: 'session-test' } } },
    toolName: 'pwsh',
    reason: 'run a build',
  };
  let release;
  let reached = false;
  const waiting = new Promise((resolve) => { release = resolve; });
  const outcome = host.ctx.waterfall('approval/request', request, async () => {
    reached = true;
    await waiting;
    return 'allowed-once';
  });

  const pending = await waitFor(async () => {
    const state = await host.state();
    return state.pending.some((item) => item.kind === 'approval') ? state : null;
  }, { label: 'pending approval recorded' });

  const approval = pending.pending.find((item) => item.kind === 'approval');
  assertEqual(approval.toolName, 'pwsh', 'tool name recorded');
  assertMatch(approval.title, /终端/, 'human-readable tool description');
  assertEqual(pending.toast.kind, 'approval', 'approval bubble');

  assertEqual(reached, true, 'the downstream answerer must be reached');
  release();
  assertEqual(await outcome, 'allowed-once', 'the chain must keep its decision');
  await waitFor(async () => !(await host.state()).pending.some((item) => item.kind === 'approval'), { label: 'approval cleared' });
});

await check('the agent plan is mirrored from the session log', async () => {
  host.ctx.emit('session/event',
    { id: 'session-test' },
    {
      type: 'todo/write',
      data: {
        todos: [
          { content: '第一步', status: 'completed' },
          { content: '第二步', status: 'in_progress' },
          { content: '第三步', status: 'pending' },
        ],
      },
    });
  const state = await waitFor(async () => {
    const current = await host.state();
    return current.plan?.todos?.length === 3 ? current : null;
  }, { label: 'plan mirrored' });
  assertEqual(state.plan.counts.completed, 1, 'completed count');
  assertEqual(state.plan.counts.inProgress, 1, 'in-progress count');
  assertEqual(state.plan.counts.pending, 1, 'pending count');
  assertEqual(state.plan.todos[1].content, '第二步', 'content, including non-ASCII');
});

// --- 7. Tools -------------------------------------------------------------
await check('pet_status reports the pet and the quota', async () => {
  const tool = await host.tool('pet_status');
  const value = await tool.execute({}, {});
  assertMatch(value.text, /Lv\.\d+/, 'reports the level');
  assertMatch(value.text, /今日完成/, 'reports today\'s work');
  assert(typeof value.level === 'number', 'returns a structured level');
});

await check('pet_notify shows a bubble and reports delivery', async () => {
  const tool = await host.tool('pet_notify');
  const value = await tool.execute({ text: '来自工具的气泡', kind: 'info' }, {});
  assertEqual(value.delivered, true, 'delivered');
  const state = await host.state();
  assertEqual(state.toast.text, '来自工具的气泡', 'the bubble is live');
});

await check('pet_notify truncates an over-long message', async () => {
  const tool = await host.tool('pet_notify');
  await tool.execute({ text: 'x'.repeat(1000) }, {});
  const state = await host.state();
  assert(state.toast.text.length <= 400, 'text is bounded');
});

await check('pet_todo drives the shared list', async () => {
  const tool = await host.tool('pet_todo');
  await tool.execute({ action: 'add', text: '工具添加' }, {});
  let value = await tool.execute({ action: 'list' }, {});
  assertMatch(value.text, /工具添加/, 'list shows the item');
  assert(value.count >= 1, 'count returned');
  await tool.execute({ action: 'clear' }, {});
  value = await tool.execute({ action: 'list' }, {});
  assertMatch(value.text, /空的/, 'reports an empty list');
});

await check('pet_control opens the page and reports a URL', async () => {
  const tool = await host.tool('pet_control');
  const value = await tool.execute({ action: 'open-page' }, {});
  // `openExternal` may or may not succeed in a headless CI shell, but the
  // command must always answer rather than throw.
  assert(typeof value.text === 'string' && value.text.length > 0, 'returns a message');
});

await check('pet_control rejects an unknown action without throwing', async () => {
  const tool = await host.tool('pet_control');
  const value = await tool.execute({ action: 'not-real' }, {});
  assertEqual(value.ok, false, 'reports failure');
});

// --- 8. Quota -------------------------------------------------------------
await check('quota reads both wallet lists and sums them', async () => {
  const tool = await host.tool('pet_quota');
  const value = await tool.execute({ refresh: true }, {});
  assertMatch(value.text, /总余额/, 'reports a total');
  const state = await host.state();
  assertEqual(state.quota.status, 'ok', 'status is set');
  assertEqual(state.quota.totalBalance, 12, 'recharge 8 + granted 4');
  assertEqual(state.quota.toppedUpBalance, 8, 'recharge wallet');
  assertEqual(state.quota.grantedBalance, 4, 'bonus wallet');
  assertEqual(state.quota.currency, 'CNY', 'currency');
  assertEqual(state.quota.level, 'ok', 'level');
  assert(state.quota.updatedAt > 0, 'timestamp recorded');
  assert(state.quota.history.length >= 1, 'history recorded');
});

await check('a signed-out account is reported as such, not as an error', async () => {
  const other = await createHost();
  try {
    other.ctx.get('deepseekAccount').getState = async () => ({ status: 'signed-out' });
    const tool = other.ctx.registeredTools.get('pet_quota');
    const value = await tool.execute({ refresh: true }, {});
    const state = await other.state();
    assertEqual(state.quota.status, 'signed-out', 'status');
    assertEqual(state.quota.signedIn, false, 'signed in flag');
    assertMatch(value.text, /未登录/, 'explains the state in the user\'s language');
  } finally {
    await other.close();
  }
});

await check('a failed balance read never fabricates a zero', async () => {
  const other = await createHost();
  try {
    other.ctx.get('deepseekAccount').getBalance = () => Promise.resolve({ status: 'failed' });
    const tool = other.ctx.registeredTools.get('pet_quota');
    await tool.execute({ refresh: true }, {});
    const state = await other.state();
    assertEqual(state.quota.status, 'failed', 'status');
    assertEqual(state.quota.totalBalance, null, 'balance stays unknown rather than zero');
    assert(state.quota.error, 'an error is recorded');
  } finally {
    await other.close();
  }
});

await check('a synchronously throwing getBalance is contained', async () => {
  const other = await createHost();
  try {
    // The real service is a plain method, so malformed metadata throws out of
    // the call expression rather than rejecting a promise.
    other.ctx.get('deepseekAccount').getBalance = () => {
      throw new Error('account: this client build carries no DSH_CLIENT_VERSION');
    };
    const tool = other.ctx.registeredTools.get('pet_quota');
    const value = await tool.execute({ refresh: true }, {});
    assertEqual(value.status, 'failed', 'reported as a failure');
    const state = await other.state();
    assertEqual(state.quota.status, 'failed', 'status');
    assertMatch(state.quota.error, /凭据|失败/, 'surfaces a readable reason');
  } finally {
    await other.close();
  }
});

await check('decimal-string wallets are parsed, not coerced', async () => {
  const other = await createHost();
  try {
    other.ctx.get('deepseekAccount').getBalance = () => Promise.resolve({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '0E-16' }, { currency: 'USD', balance: '1e+3' }],
      bonusWallets: [],
    });
    const tool = other.ctx.registeredTools.get('pet_quota');
    await tool.execute({ refresh: true }, {});
    const state = await other.state();
    assertEqual(state.quota.currency, 'CNY', 'prefers CNY when several are present');
    assertEqual(state.quota.totalBalance, 0, '0E-16 is zero, not NaN');
  } finally {
    await other.close();
  }
});

// --- 9. Server-sent events ------------------------------------------------
await check('the SSE stream opens and immediately sends the current state', async () => {
  const controller = new AbortController();
  const response = await fetch(`${host.base}/pet/api/events`, { signal: controller.signal });
  assertEqual(response.status, 200, 'stream status');
  assertMatch(response.headers.get('content-type'), /text\/event-stream/, 'stream type');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !buffer.includes('event: state')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assertMatch(buffer, /event: state/, 'first frame is the state');
  assertMatch(buffer, /"pet"/, 'frame carries the state document');
});

await check('a state change is pushed to connected clients', async () => {
  const controller = new AbortController();
  const response = await fetch(`${host.base}/pet/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Consume the initial frame.
  while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  const seen = buffer.length;

  await host.post('todo-add', { text: '推送测试' });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.slice(seen).includes('推送测试')) break;
  }
  controller.abort();
  assertMatch(buffer.slice(seen), /推送测试/, 'the new item was pushed');
});

await check('the in-app overlay is injected into the DSH page', async () => {
  const table = [];
  host.ctx.emit('webserver/index-inject', table);
  const scriptRow = table.find((row) => row.kind === 'script-src');
  assert(scriptRow, 'a script row is contributed');
  assertEqual(scriptRow.src, '/pet/embed.js', 'script src');
  assertEqual(scriptRow.placement, 'body', 'script placement');
  const styleRow = table.find((row) => row.kind === 'style');
  assert(styleRow, 'a style row is contributed');
  assertMatch(styleRow.text, /dsh-pet-overlay/, 'reserves the overlay corner');
});

// --- 10. Persistence ------------------------------------------------------
await check('state survives a restart and settings come from config', async () => {
  await host.post('todo-add', { text: '持久化测试' });
  await host.post('pet');
  const before = await host.state();

  // The store debounces its writes and the hub throttles its broadcasts, so
  // wait for the durable document rather than assuming a synchronous flush.
  const stateFile = path.join(host.stateDir, 'state.json');
  await waitFor(() => {
    try {
      const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return persisted.todos?.some((item) => item.text === '持久化测试');
    } catch {
      return false;
    }
  }, { timeoutMs: 5000, label: 'todos written to disk' });

  const restarted = await createHost({ stateDir: host.stateDir });
  try {
    const after = await restarted.state();
    assertEqual(after.todos.length, before.todos.length, 'todos persisted');
    assert(after.todos.some((item) => item.text === '持久化测试'), 'the todo text persisted, non-ASCII included');
    assert(after.pet.totalPets >= before.pet.totalPets, 'affection counter persisted');
    assert(after.quota.history.length >= 1, 'quota history persisted');
  } finally {
    await restarted.close();
  }
});

await check('a corrupt state file is quarantined rather than fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-corrupt-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json', 'utf8');
  const recovered = await createHost({ stateDir: dir });
  try {
    const state = await recovered.state();
    assertEqual(state.pet.level, 1, 'falls back to a fresh pet');
    const quarantined = fs.readdirSync(dir).filter((name) => name.includes('corrupt'));
    assert(quarantined.length === 1, 'the unreadable file is kept for inspection');
  } finally {
    await recovered.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 11. Degraded environments --------------------------------------------
await check('the plugin loads without tools, commands or a webserver', async () => {
  const ctx = new HarnessContext('bare');
  const module = await import(`file://${ROOT.replace(/\\/g, '/')}/src/host/index.js`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-bare-'));
  let threw = null;
  try {
    module.apply(ctx, { stateDir: dir, desktopEnabled: false, quotaPollSeconds: 0 });
    await new Promise((resolve) => setTimeout(resolve, 400));
  } catch (error) {
    threw = error;
  } finally {
    ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assertEqual(threw, null, `apply must not throw: ${threw?.message ?? ''}`);
});

await check('a missing account service is reported, not fatal', async () => {
  const ctx = new HarnessContext('no-account');
  const webServer = ctx.createWebServer();
  ctx.provide('webServer', webServer);
  ctx.provide('tools', ctx.createTools());
  ctx.provide('commands', ctx.createCommands());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-noaccount-'));
  try {
    const module = await import(`file://${ROOT.replace(/\\/g, '/')}/src/host/index.js`);
    module.apply(ctx, { stateDir: dir, desktopEnabled: false, quotaPollSeconds: 0 });
    await webServer.listen();
    const tool = ctx.registeredTools.get('pet_quota');
    const value = await tool.execute({ refresh: true }, {});
    assertEqual(value.status, 'failed', 'reports failure');
    const response = await fetch(`http://127.0.0.1:${webServer.port}/pet/api/state`);
    const state = await response.json();
    assertMatch(state.quota.error, /账号服务不可用/, 'explains the missing service');
  } finally {
    ctx.dispose();
    await webServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await host.close();

// ---------------------------------------------------------------------------
console.log('\ndesktop-pet host end-to-end');
console.log(results.join('\n'));
console.log(failures === 0
  ? `\nall ${results.length} checks passed.`
  : `\n${failures} of ${results.length} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
