/**
 * Turns harness activity into pet behaviour.
 *
 * Three signals matter:
 *
 *  1. **A task finished.** `agent/status` is an `emit`-mode event dispatched
 *     exactly once per `running` <-> `idle` transition, after the turn has
 *     fully closed. That is the only clean "done" edge in the system: there is
 *     no "final assistant message" event, and `agent/turn-stopping` is
 *     advisory (a listener may still steer the turn back to life).
 *
 *  2. **The agent needs the user.** `user-questions/request` and
 *     `approval/request` are `waterfall` events. A passive observer must
 *     `return next()`, otherwise it vetoes the rest of the chain and the real
 *     browser answerer never runs - so every listener here is wrapped in
 *     try/catch, registered with `prepend` (to observe before a claiming
 *     answerer can short-circuit), and unconditionally forwards `next()`.
 *     Because the listener returns the *same* promise the chain would have
 *     returned, settling it locally is a free, exact completion signal.
 *
 *  3. **Quota.** Polled on its own schedule; see `account.js`.
 *
 * A note on `this`: DSH dispatches agent-scoped events with a scope *carrier*
 * as `this`, not a Context. Every listener therefore reads from its arguments.
 *
 * @module dsh-desktop-pet/host/triggers
 */

import { makeId } from '../shared/protocol.js';
import {
  APPROVAL_LINES,
  QUESTION_LINES,
  QUOTA_LINES,
  fill,
  pick,
} from '../shared/persona.js';

/** Only root agents get a completion bubble; subagents are an implementation detail. */
function isRootAgent(agent) {
  const header = agent?.session?.header;
  if (!header) return true;
  if (header.parentSession !== undefined) return false;
  if (header.origin === 'subagent') return false;
  return true;
}

/** Best-effort human label for a session, from cheapest source to richest. */
function describeSession(ctx, agent) {
  try {
    const titled = ctx.get('sessionTitle')?.get?.(agent.session)?.title;
    if (typeof titled === 'string' && titled.trim()) return titled.trim();
  } catch {
    /* the title service is optional and may be mid-reload */
  }
  try {
    const events = agent.session?.snapshotEvents?.() ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'user/message') continue;
      const text = (event.data?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return text.length > 60 ? `${text.slice(0, 57)}...` : text;
    }
  } catch {
    /* a session without a readable log simply has no label */
  }
  return agent?.session?.header?.cwd ?? '';
}

/** Short, non-technical description of a tool that needs approval. */
function describeTool(toolName) {
  const labels = {
    pwsh: '执行终端命令',
    bash: '执行终端命令',
    write: '写入文件',
    edit: '修改文件',
    'str_replace_editor': '修改文件',
    workflow: '运行工作流',
    subagent: '启动子智能体',
  };
  return labels[toolName] ?? `使用 ${toolName}`;
}

/**
 * Wire every listener. Returns a disposer that removes them all.
 *
 * @param {object} ctx Cordis context.
 * @param {import('./hub.js').PetHub} hub
 * @param {object} [options]
 * @param {(message: string) => void} [options.log]
 */
export function installTriggers(ctx, hub, { log = () => {} } = {}) {
  const disposers = [];
  const agentState = new Map();
  const pending = new Map();

  const publishPending = () => {
    hub.setPending([...pending.values()]);
  };

  const addPending = (entry) => {
    pending.set(entry.id, entry);
    publishPending();
  };

  const clearPending = (id) => {
    if (!pending.delete(id)) return false;
    publishPending();
    return true;
  };

  /** Keep a `pending` badge from outliving a crash, an abort or a reload. */
  const sweepPending = (now = Date.now()) => {
    let changed = false;
    for (const [id, entry] of pending) {
      if (now - entry.at > 30 * 60 * 1000) {
        pending.delete(id);
        changed = true;
      }
    }
    if (changed) publishPending();
    return changed;
  };

  // -------------------------------------------------------------------
  // 1. Task completion
  // -------------------------------------------------------------------
  try {
    disposers.push(ctx.on('agent/status', (payload) => {
      try {
        const agent = payload?.agent;
        const status = payload?.status;
        if (!agent || typeof status !== 'string') return;
        const key = agent.id ?? agent.session?.id;
        if (key === undefined) return;

        const previous = agentState.get(key) ?? { running: false, since: null };

        if (status === 'running') {
          agentState.set(key, { running: true, since: Date.now() });
          hub.setActivity({
            agentRunning: true,
            activeSessions: [...agentState.values()].filter((entry) => entry.running).length,
            sessionId: String(key),
            sessionTitle: describeSession(ctx, agent),
            turnStartedAt: Date.now(),
          });
          return;
        }

        if (status !== 'idle') return;

        const wasRunning = previous.running;
        const startedAt = previous.since;
        agentState.set(key, { running: false, since: null });

        const stillRunning = [...agentState.values()].filter((entry) => entry.running).length;
        hub.setActivity({
          agentRunning: stillRunning > 0,
          activeSessions: stillRunning,
          sessionId: stillRunning === 0 ? null : String(key),
          turnStartedAt: null,
          currentTool: null,
        });

        // Only announce a genuine running -> idle transition, and only for the
        // user's own top-level work.
        if (!wasRunning || !isRootAgent(agent)) return;
        if (!hub.state.settings.notifyOnTaskDone) return;

        const title = describeSession(ctx, agent);
        hub.recordTaskComplete({
          title,
          durationMs: typeof startedAt === 'number' ? Date.now() - startedAt : null,
          sessionId: String(key),
        });
      } catch (error) {
        log(`desktop-pet: agent/status handler failed: ${error?.message ?? error}`);
      }
    }));
  } catch (error) {
    log(`desktop-pet: cannot subscribe to agent/status: ${error?.message ?? error}`);
  }

  // -------------------------------------------------------------------
  // 2a. The agent is asking the user a structured question
  // -------------------------------------------------------------------
  try {
    disposers.push(ctx.on('user-questions/request', (request, next) => {
      let token = null;
      try {
        const questions = Array.isArray(request?.questions) ? request.questions : [];
        const first = questions[0];
        const title = first?.header || first?.question || '需要你确认';
        token = makeId('q');
        addPending({
          id: token,
          kind: 'question',
          title: String(title).slice(0, 120),
          detail: questions.length > 1 ? `共 ${questions.length} 个问题` : '',
          sessionId: request?.agent?.id ? String(request.agent.id) : null,
          at: Date.now(),
          count: questions.length,
        });
        if (hub.state.settings.notifyOnUserAction && !hub.state.settings.mute) {
          hub.toast({
            kind: 'question',
            title: '需要你回答',
            text: pick(QUESTION_LINES, { title: String(title).slice(0, 40) }, null),
            key: `question-${token}`,
            sticky: true,
            actions: [{ id: 'go', label: '去回答', action: 'open-dsh' }],
          });
        }
      } catch (error) {
        log(`desktop-pet: question observer failed: ${error?.message ?? error}`);
      }

      // Forwards the chain unchanged. The pet must never be able to block a
      // question, so this call happens outside the try/catch above.
      const answered = next();
      Promise.resolve(answered)
        .catch(() => undefined)
        .finally(() => {
          if (token) clearPending(token);
          hub.dismissToast(`question-${token}`);
        });
      return answered;
    }, { prepend: true }));
  } catch (error) {
    log(`desktop-pet: cannot observe user-questions/request: ${error?.message ?? error}`);
  }

  // -------------------------------------------------------------------
  // 2b. The agent needs an approval
  // -------------------------------------------------------------------
  try {
    disposers.push(ctx.on('approval/request', (request, next) => {
      let token = null;
      try {
        const toolName = String(request?.toolName ?? 'unknown');
        token = makeId('a');
        addPending({
          id: token,
          kind: 'approval',
          title: describeTool(toolName),
          detail: String(request?.reason ?? '').slice(0, 160),
          toolName,
          sessionId: request?.agent?.id ? String(request.agent.id) : null,
          at: Date.now(),
        });
        if (hub.state.settings.notifyOnUserAction && !hub.state.settings.mute) {
          hub.toast({
            kind: 'approval',
            title: '需要你批准',
            text: pick(APPROVAL_LINES, { title: describeTool(toolName) }, null),
            key: `approval-${token}`,
            sticky: true,
            actions: [{ id: 'go', label: '去处理', action: 'open-dsh' }],
          });
        }
      } catch (error) {
        log(`desktop-pet: approval observer failed: ${error?.message ?? error}`);
      }

      const decided = next();
      Promise.resolve(decided)
        .catch(() => undefined)
        .finally(() => {
          if (token) clearPending(token);
          hub.dismissToast(`approval-${token}`);
        });
      return decided;
    }, { prepend: true }));
  } catch (error) {
    log(`desktop-pet: cannot observe approval/request: ${error?.message ?? error}`);
  }

  // -------------------------------------------------------------------
  // 3. Durable backstops from the session log
  // -------------------------------------------------------------------
  // `approval/request` is never dispatched while the session policy is
  // `never` - in that mode the service auto-rejects without asking anyone, so
  // there is nothing to notify about. These listeners exist to keep the
  // pending list honest across reloads and aborts.
  try {
    disposers.push(ctx.on('session/event', (session, event) => {
      try {
        if (!event?.type) return;
        if (event.type === 'approval/decided') {
          for (const [id, entry] of pending) {
            if (entry.kind === 'approval') {
              pending.delete(id);
              hub.dismissToast(`approval-${id}`);
            }
          }
          publishPending();
        }
        if (event.type === 'turn/end') {
          // A turn ending means nothing is waiting on the user from that turn.
          let changed = false;
          for (const [id, entry] of pending) {
            pending.delete(id);
            hub.dismissToast(`${entry.kind === 'question' ? 'question' : 'approval'}-${id}`);
            changed = true;
          }
          if (changed) publishPending();
        }
      } catch (error) {
        log(`desktop-pet: session/event handler failed: ${error?.message ?? error}`);
      }
    }, { global: true }));
  } catch (error) {
    log(`desktop-pet: cannot subscribe to session/event: ${error?.message ?? error}`);
  }

  // -------------------------------------------------------------------
  // 4. Inter-agent activity, so the pet looks busy while work happens
  // -------------------------------------------------------------------
  try {
    disposers.push(ctx.on('tools/result', (exec) => {
      try {
        const name = exec?.schema?.name;
        if (typeof name === 'string') hub.setActivity({ currentTool: name });
      } catch {
        /* a malformed execution is not worth a log line */
      }
    }));
  } catch {
    /* tools/result is a nicety; its absence must not break the plugin */
  }

  return {
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* the loader may already have torn the listener down */
        }
      }
      agentState.clear();
      pending.clear();
    },
    sweepPending,
    get pendingCount() {
      return pending.size;
    },
    /** Lines used by the quota bubble, exported so it stays in one place. */
    quotaLines: {
      warnLines: QUOTA_LINES.warn,
      criticalLines: QUOTA_LINES.critical,
      recoveredLines: QUOTA_LINES.recovered,
      fill,
    },
  };
}
