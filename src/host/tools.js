/**
 * The pet's agent-facing surface: tools the model can call, plus a slash
 * command for the human.
 *
 * These are hand-built `ToolDefinition` objects rather than `defineTool(...)`
 * output. `defineTool` lives in `@deepseek-ai/dsh-tools`, which would become a
 * runtime import for a plugin that otherwise depends on nothing but Node
 * builtins; the registry accepts the compiled shape directly, so the JSON
 * Schema is written out here instead.
 *
 * @module dsh-desktop-pet/host/tools
 */

/** Shared schema fragment for a free-text argument. */
const text = (description) => ({ type: 'string', description });

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Wrap a value as the single text block the model reads. */
function renderText(value, fallback) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (value && typeof value.text === 'string') return [{ type: 'text', text: value.text }];
  return [{ type: 'text', text: fallback ?? JSON.stringify(value) }];
}

/**
 * Register every tool and command.
 *
 * @param {object} ctx A context that already provides `tools`/`commands`.
 * @param {object} api
 * @param {import('./hub.js').PetHub} api.hub
 * @param {(action: object) => Promise<object>} api.dispatch Runs a pet action.
 * @param {(message: string) => void} [api.log]
 */
export function installTools(ctx, api) {
  const { hub, dispatch, log = () => {} } = api;
  const disposers = [];

  const registerTool = (definition) => {
    try {
      disposers.push(ctx.tools.register(definition));
    } catch (error) {
      log(`desktop-pet: cannot register tool ${definition.name}: ${error?.message ?? error}`);
    }
  };

  // -------------------------------------------------------------------
  // pet_notify - the reason this plugin exists from the model's side
  // -------------------------------------------------------------------
  registerTool({
    name: 'pet_notify',
    description:
      'Raise a bubble on the user\'s desktop pet to get their attention. Use this when you '
      + 'need the user to do something before you can continue, when a long-running task has '
      + 'finished, or when you have a status worth interrupting for. The bubble floats above '
      + 'every other window on their desktop. Keep the text under ~80 characters. Prefer '
      + '`sticky: true` when you are blocked and need an answer; otherwise the bubble fades on '
      + 'its own.',
    parameters: objectSchema(
      {
        text: text('What the pet should say. Short, specific, and friendly.'),
        title: text('Optional bold headline, for example "需要你确认".'),
        kind: {
          type: 'string',
          enum: ['done', 'question', 'approval', 'quota', 'error', 'reminder', 'info'],
          description: 'Visual style and urgency of the bubble. Defaults to "info".',
        },
        sticky: {
          type: 'boolean',
          description: 'Keep the bubble on screen until the user dismisses it. Use when blocked.',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'high also raises a Windows notification and plays the alert sound.',
        },
      },
      ['text'],
    ),
    output: {
      schema: objectSchema(
        {
          delivered: { type: 'boolean' },
          toastId: { type: 'string' },
          note: { type: 'string' },
        },
        ['delivered'],
      ),
      render: (_args, value) => renderText(value.note ?? (value.delivered ? 'Bubble shown.' : 'Bubble suppressed.')),
    },
    execute(args) {
      const result = dispatch({
        type: 'notify',
        text: String(args.text ?? '').slice(0, 400),
        title: args.title ? String(args.title).slice(0, 80) : '',
        kind: args.kind ?? 'info',
        sticky: args.sticky === true || args.urgency === 'high',
        urgency: args.urgency ?? 'normal',
      });
      return Promise.resolve(result).then((outcome) => ({
        delivered: outcome?.delivered !== false,
        toastId: outcome?.toastId ?? '',
        note: outcome?.note ?? '',
      }));
    },
  });

  // -------------------------------------------------------------------
  // pet_status
  // -------------------------------------------------------------------
  registerTool({
    name: 'pet_status',
    description:
      'Read the desktop pet\'s current state: level and experience, today\'s completed-task '
      + 'count, the DeepSeek platform balance and burn rate, any pending question or approval, '
      + 'and the pomodoro timer. Useful for reporting quota or progress to the user in chat.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema(
        {
          text: { type: 'string' },
          level: { type: 'integer' },
          tasksToday: { type: 'integer' },
          balance: { type: 'string' },
          pending: { type: 'integer' },
        },
        ['text'],
      ),
      render: (_args, value) => renderText(value.text),
    },
    execute() {
      return Promise.resolve({ text: api.describeStatus(), ...api.statusSummary() });
    },
  });

  // -------------------------------------------------------------------
  // pet_quota
  // -------------------------------------------------------------------
  registerTool({
    name: 'pet_quota',
    description:
      'Read the DeepSeek open-platform balance, or force a fresh reading. The balance is '
      + 'returned as recharge and granted wallets per currency, plus the burn rate and the '
      + 'estimated days of runway at that rate. Set `refresh: true` to bypass any cached '
      + 'reading and hit the platform API now.',
    parameters: objectSchema(
      {
        refresh: { type: 'boolean', description: 'Fetch a fresh reading instead of the last one.' },
      },
    ),
    output: {
      schema: objectSchema(
        {
          text: { type: 'string' },
          status: { type: 'string' },
          total: { type: 'number' },
          currency: { type: 'string' },
        },
        ['text'],
      ),
      render: (_args, value) => renderText(value.text),
    },
    async execute(args) {
      if (args?.refresh === true) {
        await dispatch({ type: 'refresh-quota', force: true });
      }
      return { text: api.describeQuota(), status: hub.state.quota.status, total: hub.state.quota.totalBalance ?? 0, currency: hub.state.quota.currency ?? '' };
    },
  });

  // -------------------------------------------------------------------
  // pet_control
  // -------------------------------------------------------------------
  registerTool({
    name: 'pet_control',
    description:
      'Control the desktop pet: show or hide the floating window, start or stop the pomodoro '
      + 'timer, mute or unmute bubbles, open the pet page in a browser, or change the pet\'s '
      + 'scale. Use `action: "settings"` with `settings` to change several preferences at once.',
    parameters: objectSchema(
      {
        action: {
          type: 'string',
          enum: ['show', 'hide', 'restart', 'pomodoro-start', 'pomodoro-break', 'pomodoro-stop', 'mute', 'unmute', 'open-page', 'page-url', 'settings'],
          description: 'What to do. "page-url" returns the link other devices should open.',
        },
        minutes: { type: 'integer', description: 'Pomodoro length for pomodoro-start / pomodoro-break.' },
        settings: {
          type: 'object',
          additionalProperties: true,
          description: 'Preference overrides applied with action "settings", e.g. { "desktopScale": 1.2 }.',
        },
      },
      ['action'],
    ),
    output: {
      schema: objectSchema({ text: { type: 'string' }, ok: { type: 'boolean' } }, ['text']),
      render: (_args, value) => renderText(value.text),
    },
    async execute(args) {
      const result = await dispatch({
        type: String(args.action),
        minutes: args.minutes,
        settings: args.settings,
        source: 'tool',
      });
      return { ok: result?.ok !== false, text: result?.message ?? 'Done.' };
    },
  });

  // -------------------------------------------------------------------
  // pet_todo - the pet's own checklist, separate from the session plan
  // -------------------------------------------------------------------
  registerTool({
    name: 'pet_todo',
    description:
      'Manage the checklist shown on the user\'s desktop pet. This is a lightweight personal '
      + 'list that survives restarts and is visible on every surface. Prefer the session '
      + '`todo_write` tool for your own planning; use this when the user asks you to note '
      + 'something down, or to hand them a short list to work through.',
    parameters: objectSchema(
      {
        action: { type: 'string', enum: ['list', 'add', 'toggle', 'remove', 'clear'], description: 'Operation to perform.' },
        text: text('Item text for "add".'),
        id: text('Item id for "toggle" or "remove".'),
      },
      ['action'],
    ),
    output: {
      schema: objectSchema({ text: { type: 'string' }, count: { type: 'integer' } }, ['text']),
      render: (_args, value) => renderText(value.text),
    },
    async execute(args) {
      const result = await dispatch({
        type: `todo-${String(args.action)}`,
        text: args.text,
        id: args.id,
        source: 'tool',
      });
      return { text: result?.message ?? 'Done.', count: hub.state.todos.length };
    },
  });

  // -------------------------------------------------------------------
  // Slash command for the human
  // -------------------------------------------------------------------
  try {
    disposers.push(ctx.commands.register({
      definitionId: 'dsh-desktop-pet/pet',
      name: 'pet',
      description: '控制桌宠：状态、额度、显示/隐藏、静音、番茄钟',
      input: { hint: '[status|quota|url|show|hide|mute|unmute|pomodoro [分钟]|stop|page|restart]' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim();
        const [verb = 'status', ...rest] = raw.split(/\s+/u);
        try {
          switch (verb.toLowerCase()) {
            case '':
            case 'status': {
              return { kind: 'success', text: `${api.describeStatus()}\n\n${api.describeQuota()}` };
            }
            case 'quota': {
              await dispatch({ type: 'refresh-quota', force: true });
              return { kind: 'success', text: api.describeQuota() };
            }
            case 'url':
            case 'link': {
              const result = await dispatch({ type: 'page-url', source: 'command' });
              return result?.url
                ? { kind: 'success', text: result.message }
                : { kind: 'error', text: result?.message ?? '无法获取链接' };
            }
            case 'show':
            case 'hide':
            case 'restart':
            case 'mute':
            case 'unmute':
            case 'page': {
              const action = verb.toLowerCase() === 'page' ? 'open-page' : verb.toLowerCase();
              const result = await dispatch({ type: action, source: 'command' });
              return result?.ok === false
                ? { kind: 'error', text: result.message ?? '操作失败' }
                : { kind: 'success', text: result?.message ?? '完成' };
            }
            case 'pomodoro': {
              const minutes = Number.parseInt(rest[0] ?? '', 10);
              const result = await dispatch({
                type: 'pomodoro-start',
                minutes: Number.isFinite(minutes) ? minutes : undefined,
                source: 'command',
              });
              return { kind: 'success', text: result?.message ?? '计时开始' };
            }
            case 'stop': {
              const result = await dispatch({ type: 'pomodoro-stop', source: 'command' });
              return { kind: 'success', text: result?.message ?? '已停止' };
            }
            case 'scale': {
              const value = Number.parseFloat(rest[0] ?? '');
              if (!Number.isFinite(value)) return { kind: 'error', text: '用法：/pet scale <0.5-3.0>' };
              const result = await dispatch({ type: 'settings', settings: { desktopScale: value }, source: 'command' });
              return { kind: 'success', text: result?.message ?? '已更新' };
            }
            default:
              return { kind: 'error', text: `未知子命令 "${verb}"。用法：/pet [status|quota|show|hide|mute|unmute|pomodoro [分钟]|stop|page|restart|scale <倍数>]` };
          }
        } catch (error) {
          return { kind: 'error', text: `桌宠命令失败：${error?.message ?? error}` };
        }
      },
    }));
  } catch (error) {
    log(`desktop-pet: cannot register the /pet command: ${error?.message ?? error}`);
  }

  return {
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* already unwound */
        }
      }
    },
    names: ['pet_notify', 'pet_status', 'pet_quota', 'pet_control', 'pet_todo'],
  };
}
