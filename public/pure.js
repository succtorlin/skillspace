// Pure helpers: no DOM, no storage, no network. Split out so node:test can
// require() them - public/app.js ends in a bare boot() call, so requiring it
// would run the whole app. Loaded as a classic script before app.js, matching
// how icons.js already works.

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// escAttr exists for values that land inside an ATTRIBUTE - today the title on
// a project row, which carries a user-supplied path. esc() alone handles only
// & < >, so a path containing a double quote would close the attribute and let
// the rest parse as markup. Order matters: esc() escapes & first, so appending
// the quote replacement after it is what keeps " -> &quot; rather than
// &amp;quot;.
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// What the rail should show for a given /api/projects response. `ok` is
// response.ok; `data` is the parsed body, or null if there was none.
// A structured error from a well-behaved server must NOT read as "empty":
// checking only Array.isArray(data.projects) sent a 500 {"error":…} into the
// empty state, which told the user to add projects they already have. The API
// accepts the same path twice, so following that advice duplicates records.
function railState(ok, data) {
  if (!ok || !data || data.error || !Array.isArray(data.projects)) {
    return { kind: 'error', projects: [] };
  }
  if (!data.projects.length) return { kind: 'empty', projects: [] };
  return { kind: 'list', projects: data.projects };
}

// What a DELETE response means. `body` is the parsed body, or null when the
// request produced none at all (unreachable server / unparseable response).
// shouldReload distinguishes the two failure kinds: a 404 says the record is
// already gone, so the view is stale and must reconcile or the phantom row
// keeps 404ing on every retry. An unreachable server says nothing about the
// record, so re-rendering would only trade a good list for an error box.
function deleteOutcome(body) {
  if (body === null) {
    return { ok: false, message: '删除失败：无法连接服务器', shouldReload: false };
  }
  if (!body || body.error || body.ok !== true) {
    return {
      ok: false,
      message: '删除失败：' + ((body && body.error) || '未知错误'),
      shouldReload: true,
    };
  }
  return { ok: true, message: null, shouldReload: true };
}

// ============================================================
// Board helpers — plan 3. Pure like everything above: no DOM, no fetch.
// Every top-level name here is a browser GLOBAL shared with app.js and the
// three board scripts; test/public-globals.test.js fails on a collision.
// ============================================================

// Mirrors of lib/orders.SETTLED and lib/goals.SETTLED. Copied because this file
// runs in the browser; test/board-pure.test.js pins them to the originals.
const ORDER_SETTLED_STATES = ['succeeded', 'failed', 'cancelled', 'interrupted'];
const GOAL_SETTLED_STATES = ['done', 'failed'];

// GET /api/orders with an EMPTY project= lists every order in the store
// (routes/orders.js Known limits). The board must never send it.
function boardQuery(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) return null;
  return '/api/orders?project=' + encodeURIComponent(projectId);
}

// lib/plan assigns seq as a 0-based index; people count from one. A one-off
// order (POST /api/orders) has seq null.
function seqLabel(order) {
  const s = order && order.seq;
  if (!Number.isInteger(s) || s < 0) return '··';
  return String(s + 1).padStart(2, '0');
}
function seqSpoken(order) {
  const s = order && order.seq;
  return Number.isInteger(s) && s >= 0 ? `第 ${s + 1} 单` : '一次性订单';
}

// lib/orders truncates titles and the PM may omit one; the prompt's first line
// stands in, bounded by code point so a CJK cut never lands mid-glyph.
function orderTitle(order) {
  const t = order && typeof order.title === 'string' ? order.title.trim() : '';
  if (t) return t;
  const first = order && typeof order.prompt === 'string' ? order.prompt.trim().split('\n')[0].trim() : '';
  if (!first) return '（无标题）';
  const chars = Array.from(first);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : first;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// null means "it never ran" - lib/orders.markFailed nulls startedAt for exactly
// that, and the board must not show 0s for an agent that never existed.
function orderElapsed(order, now) {
  if (!order || !order.startedAt) return null;
  const start = Date.parse(order.startedAt);
  const end = order.finishedAt ? Date.parse(order.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// `succeeded` is "退出 0", never "成功": spec §3 stores exit-0 and verified as
// different claims, and the word on the board is where they would collapse.
const ORDER_STATUS_TEXT = {
  queued: '排队', running: '运行中', succeeded: '退出 0',
  failed: '失败', cancelled: '已取消', interrupted: '中断',
};
function orderStatusText(status) {
  return Object.prototype.hasOwnProperty.call(ORDER_STATUS_TEXT, status)
    ? ORDER_STATUS_TEXT[status]
    : `未知状态（${String(status)}）`;
}

function exitCodeText(order) {
  if (!order) return '—';
  if (Number.isInteger(order.exitCode)) return String(order.exitCode);
  if (order.status === 'running') return '还在运行';
  if (order.status === 'queued') return '还没运行';
  if (order.error === 'timeout') return '无（超时被终止）';
  if (!order.startedAt) return '无（没有启动）';
  return '无';
}

// Why a settled order did not simply exit 0. `timeout` and `exit` are kept
// apart on purpose (spec §8a): one is SkillSpace killing a stuck agent, the
// other is the agent giving up on its own, and they call for different fixes.
// The budget passed in is the project's CURRENT one; the copy says so.
function failureView(order, budget) {
  if (!order) return null;
  const st = order.status;
  if (st === 'cancelled') {
    return {
      kind: 'cancelled', title: '已取消',
      detail: order.startedAt
        ? '运行中被取消：先 SIGTERM，5 秒后仍未退出就 SIGKILL。'
        : '取消时它还没开始运行。',
    };
  }
  if (st === 'interrupted') {
    return {
      kind: 'interrupted', title: '被中断',
      detail: 'SkillSpace 重启时它还在运行。那个进程已不受管，结果未知——不按成功算。',
    };
  }
  if (st !== 'failed') return null;
  if (order.error === 'timeout') {
    const limit = budget && Number.isFinite(budget.orderTimeoutMs) ? fmtDuration(budget.orderTimeoutMs) : null;
    return {
      kind: 'timeout', title: '超时，被终止',
      detail: `运行超过项目的时长上限${limit ? `（现在是 ${limit}）` : ''}，被 SkillSpace 终止。不是 agent 自己退出，所以没有退出码。`,
    };
  }
  if (!order.startedAt) {
    return { kind: 'never-started', title: '没有启动', detail: order.error ? String(order.error) : '原因没有记录。' };
  }
  if (Number.isInteger(order.exitCode)) {
    return { kind: 'exit', title: `退出码 ${order.exitCode}`, detail: 'agent 自己以非零退出码结束。它的输出在下面的日志里。' };
  }
  if (order.error) return { kind: 'error', title: '运行出错', detail: String(order.error) };
  return { kind: 'signal', title: '被信号终止', detail: '进程没有留下退出码，也没有记录原因。' };
}

// Board order: what needs eyes first. `interrupted` shares the failed group -
// both are "this did not finish cleanly" - and the row text tells them apart.
const BOARD_GROUPS = [
  { key: 'running', label: '运行中' },
  { key: 'queued', label: '排队' },
  { key: 'failed', label: '失败 · 中断' },
  { key: 'succeeded', label: '退出 0 · 尚无验收' },
  { key: 'cancelled', label: '已取消' },
];
function boardGroupKey(order) {
  const st = order && order.status;
  if (st === 'interrupted') return 'failed';
  return BOARD_GROUPS.some((g) => g.key === st) ? st : 'unknown';
}
function boardTime(s) {
  const n = Date.parse(s || '');
  return Number.isFinite(n) ? n : 0;
}
function boardSortFor(key, list) {
  const copy = list.slice();
  if (key === 'queued') {
    return copy.sort((a, b) => boardTime(a.createdAt) - boardTime(b.createdAt) || String(a.id).localeCompare(String(b.id)));
  }
  if (key === 'running') return copy.sort((a, b) => boardTime(a.startedAt) - boardTime(b.startedAt));
  return copy.sort((a, b) => boardTime(b.finishedAt) - boardTime(a.finishedAt) || String(b.id).localeCompare(String(a.id)));
}
function groupOrders(orders) {
  const list = Array.isArray(orders) ? orders.filter(Boolean) : [];
  const buckets = new Map(BOARD_GROUPS.map((g) => [g.key, []]));
  const unknown = [];
  for (const o of list) {
    const bucket = buckets.get(boardGroupKey(o));
    if (bucket) bucket.push(o);
    else unknown.push(o);
  }
  const groups = BOARD_GROUPS
    .map((g) => ({ key: g.key, label: g.label, orders: boardSortFor(g.key, buckets.get(g.key)) }))
    .filter((g) => g.orders.length);
  if (unknown.length) groups.push({ key: 'unknown', label: '状态无法识别', orders: unknown });
  return groups;
}

// lib/orders.localDay: LOCAL date, because a cap that resets at 7pm on a UTC-5
// host is a bug the user experiences.
function localDayKey(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function ordersToday(orders, now) {
  const today = localDayKey(now);
  return (Array.isArray(orders) ? orders : []).filter((o) => o && localDayKey(o.createdAt) === today).length;
}

// What changes a row's rendering. The board re-renders only when this does,
// so a focused row is not destroyed every two seconds by an identical poll.
function boardSignature(orders) {
  return (Array.isArray(orders) ? orders : [])
    .map((o) => [
      o && o.id, o && o.status, o && o.agent, o && o.error, o && o.exitCode,
      // Plan 2d's fields and Task 0's claim change a row's words too.
      o && o.verdict, o && o.verdictState, o && o.supersedes, o && o.claimed,
    ].join(':'))
    .join('|');
}

// Same discipline as railState: an error body is never "empty", and a filter
// that matches nothing is not "this project has no orders".
function boardState(ok, data, onlyIds) {
  if (!ok || !data || data.error || !Array.isArray(data.orders)) {
    return { kind: 'error', orders: [], message: data && typeof data.error === 'string' ? data.error : null };
  }
  if (!data.orders.length) return { kind: 'empty', orders: [] };
  if (!onlyIds) return { kind: 'list', orders: data.orders };
  const keep = data.orders.filter((o) => o && onlyIds.has(o.id));
  return keep.length ? { kind: 'list', orders: keep } : { kind: 'filtered', orders: [] };
}

// goal.orderIds is the authoritative list (lib/plan); an order's goalId is
// only a back-pointer that survives a rollback. Stored unvalidated, so screened.
function goalOrderIds(goals, goalId) {
  const g = Array.isArray(goals) ? goals.find((x) => x && x.id === goalId) : null;
  return new Set(g && Array.isArray(g.orderIds) ? g.orderIds.filter((id) => typeof id === 'string') : []);
}

// The scheduler, read the way routes/scheduler.js says it must be read:
// `running` is "timer armed", not progress (lastTickAt answers that), and
// lastError is never cleared, so only a rising `errors` count or a fresh
// lastErrorAt means "erroring now". `prev` is the previous poll, or null.
// `projectId` is the board's project: since plan 3 Task 0 the route names the
// paused projects, so this board's own pause is said so and another
// project's is not blamed on it.
function schedulerView(prev, cur, now, projectId) {
  const s = cur && cur.scheduler;
  if (!s || typeof s !== 'object') {
    return { kind: 'unknown', text: '读不到调度器状态', detail: '订单会不会自动开始，现在无法确定。', lastError: null };
  }
  const errAt = Date.parse(s.lastErrorAt || '');
  const lastError = s.lastError && Number.isFinite(errAt)
    ? { message: String(s.lastError), ago: fmtDuration(now - errAt) + '前' }
    : null;
  if (!s.running) {
    return { kind: 'off', text: '调度器关闭', detail: '订单停在排队，逐单点「派发」才会运行。', lastError };
  }
  const interval = Number.isFinite(s.intervalMs) && s.intervalMs > 0 ? s.intervalMs : 1000;
  const tickAt = Date.parse(s.lastTickAt || '');
  if (!Number.isFinite(tickAt) || now - tickAt > Math.max(10000, interval * 10)) {
    return {
      kind: 'stalled', text: '调度器没有在轮询',
      detail: Number.isFinite(tickAt) ? `上次轮询在 ${fmtDuration(now - tickAt)}前。` : '启动后还没轮询过。',
      lastError,
    };
  }
  const p = prev && prev.scheduler;
  const rising = !!p && Number.isFinite(p.errors) && Number.isFinite(s.errors) && s.errors > p.errors;
  const fresh = Number.isFinite(errAt) && now - errAt < interval * 3;
  if (rising || fresh) {
    return { kind: 'erroring', text: '调度器在报错', detail: String(s.lastError || '没有记录错误内容'), lastError };
  }
  const pausedIds = Array.isArray(s.pausedProjectIds) ? s.pausedProjectIds.filter((x) => x && x.id) : null;
  const mine = pausedIds && projectId ? pausedIds.find((x) => x.id === projectId) : null;
  if (mine) {
    const untilMs = Date.parse(mine.until || '');
    return {
      kind: 'paused', text: '这个项目暂停中',
      detail: `连续 ${Number.isFinite(mine.consecutive) ? mine.consecutive : '几'} 单没能启动（通常是建不了 worktree），` +
        (Number.isFinite(untilMs) ? `${fmtDuration(untilMs - now)}后再试。` : '一分钟后再试。'),
      lastError,
    };
  }
  // An older server sends only the count; then this board cannot tell, and
  // says so rather than guessing either way.
  if (!pausedIds && Number.isFinite(s.pausedProjects) && s.pausedProjects > 0) {
    return {
      kind: 'paused', text: `${s.pausedProjects} 个项目暂停中`,
      detail: '连续几单没能启动，暂停一分钟后再试。状态接口没有说是哪个项目。',
      lastError,
    };
  }
  const othersPaused = pausedIds ? pausedIds.length : 0;
  const skipAt = s.lastSkip ? Date.parse(s.lastSkip.at || '') : NaN;
  const freshSkip = Number.isFinite(skipAt) && now - skipAt < interval * 3;
  // A hold is the human's own choice (Task 0), not a fault: no danger colour.
  if (freshSkip && s.lastSkip.reason === 'goal held for review') {
    return { kind: 'held', text: '调度器运行中 · 有目标等你放行', detail: '审阅它的计划后，点「开始运行」。', lastError };
  }
  if (freshSkip) {
    return {
      kind: 'blocked', text: '有订单被挡住',
      detail: `${String(s.lastSkip.reason || '')}（可能是别的项目的订单）`,
      lastError,
    };
  }
  // Plan 2d: `judging` false means no verdicts are being given at all, so an
  // exit 0 will stay "awaiting a verdict" forever. Said once, beside the rest.
  const notes = [];
  if (s.judging === false) notes.push('验收没有开启：退出 0 的订单不会被 PM 判定。');
  if (othersPaused) notes.push(`别的项目有 ${othersPaused} 个暂停中。`);
  const n = Number.isFinite(s.inFlight) ? s.inFlight : 0;
  if (n > 0) {
    return { kind: 'working', text: `调度器运行中 · 它派出的 ${n} 单在跑`, detail: ['手动派发的订单不计在内。', ...notes].join(' '), lastError };
  }
  return { kind: 'idle', text: '调度器运行中 · 空闲', detail: notes.length ? notes.join(' ') : null, lastError };
}

// What submitting a goal will actually do. Since plan 3 Task 0 a goal can be
// posted HELD: its orders wait for a release whatever the scheduler is doing.
// Without the hold and with the scheduler on, a planned goal's orders start on
// its next tick. Unknown fails CLOSED - it is not read as "manual".
function reviewMode(cur, hold) {
  const s = cur && cur.scheduler;
  const known = !!s && typeof s === 'object';
  if (hold === true) {
    return {
      kind: 'held', submitLabel: '交给 PM 拆解（先审后跑）',
      note: '计划落地后先停住：订单留在排队，你读完计划点「开始运行」，或逐单派发。' +
        (known && !s.running ? '调度器关闭时，「开始运行」只是解除暂停，订单仍要逐单派发。' : ''),
    };
  }
  if (!known) {
    return { kind: 'unknown', submitLabel: '交给 PM 拆解', note: '读不到调度器状态：计划落地后订单会不会自动开始，现在无法确定。想先读计划，勾选「先审后跑」。' };
  }
  if (s.running) {
    const secs = Number.isFinite(s.intervalMs) && s.intervalMs > 0 ? Math.max(1, Math.round(s.intervalMs / 1000)) : 1;
    return {
      kind: 'auto', submitLabel: '交给 PM 拆解并自动运行',
      note: `调度器在运行：计划一落地，约 ${secs} 秒后订单就开始自动运行（受并发上限约束），不等你看。想先读计划，勾选「先审后跑」。`,
    };
  }
  return { kind: 'manual', submitLabel: '交给 PM 拆解', note: '调度器已关闭：计划落地后订单停在排队，你逐单点「派发」才会运行。' };
}

// Spec §8a, in the terms the dispatcher actually controls. Nothing here is a
// spend figure, and the caveat says why.
function budgetView(project, orders, now) {
  const b = (project && project.budget) || {};
  const isGit = !!project && project.kind === 'git';
  const n = (v) => Number.isFinite(v);
  const today = ordersToday(orders, now);
  const over = n(b.maxOrdersPerDay) && today >= b.maxOrdersPerDay;
  return {
    concurrency: {
      value: isGit ? `最多同时 ${project.concurrency} 单` : '同时 1 单',
      note: isGit ? '每单在自己的 git worktree 里运行，互不干扰。' : '普通目录无法隔离，两个 agent 同时改会互相覆盖，所以这里一次只跑一单。',
    },
    rows: [
      {
        key: 'perGoal', label: '每个目标',
        value: n(b.maxOrdersPerGoal) ? `≤ ${b.maxOrdersPerGoal} 单` : '未设上限',
        note: 'PM 的计划超过上限会被整份拒绝，不会截断成前几单执行。驳回后的重试也算在里面。', over: false,
      },
      {
        key: 'attempts', label: '每单尝试',
        value: n(b.maxAttemptsPerOrder) ? `≤ ${b.maxAttemptsPerOrder} 次` : '未设上限',
        note: '被驳回后自动重试的上限；你手动点「重试」不受它限制，但仍受上面两个上限约束。', over: false,
      },
      {
        key: 'timeout', label: '每单时长',
        value: n(b.orderTimeoutMs) ? `≤ ${fmtDuration(b.orderTimeoutMs)}` : '未设上限',
        note: '到点先 SIGTERM，5 秒后 SIGKILL，记为「超时」。', over: false,
      },
      {
        key: 'daily', label: '今日已创建',
        value: n(b.maxOrdersPerDay) ? `${today} / ${b.maxOrdersPerDay}` : String(today),
        note: over
          ? '已到上限：调度器让排队的订单等到明天；手动派发会直接记为失败。'
          : '按创建计数，不是按运行计数；本地日期零点重置。',
        over,
      },
    ],
    caveat: '这些限制约束的是订单的数量和时长，不是花费。SkillSpace 看不到 token 或金额，单个订单在时限内仍可能很贵。',
  };
}

function orderTransitions(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return [];
  const before = new Map(prev.filter(Boolean).map((o) => [o.id, o.status]));
  const out = [];
  for (const o of next) {
    if (!o) continue;
    if (!before.has(o.id)) out.push({ id: o.id, from: null, to: o.status, order: o });
    else if (before.get(o.id) !== o.status) out.push({ id: o.id, from: before.get(o.id), to: o.status, order: o });
  }
  return out;
}

// ONE polite sentence per poll, never a sentence per row: a five-order goal
// settling at once must not queue five announcements behind each other.
function announcement(transitions) {
  if (!Array.isArray(transitions) || !transitions.length) return '';
  const added = transitions.filter((t) => t.from === null).length;
  const moved = transitions.filter((t) => t.from !== null);
  const parts = moved.slice(0, 3).map((t) => {
    const f = failureView(t.order, null);
    return `${seqSpoken(t.order)}「${orderTitle(t.order)}」${f ? f.title : orderStatusText(t.to)}`;
  });
  if (moved.length > 3) parts.push(`另有 ${moved.length - 3} 单状态变化`);
  if (added) parts.unshift(`新增 ${added} 单`);
  return parts.join('；');
}

// Done means settled AND drained: a settled order may still have bytes the
// client has not fetched (the route reads status before the slice for this).
function logStep(body, live) {
  const log = body && body.log;
  if (!log || typeof log !== 'object' || !Number.isSafeInteger(log.next) || log.next < 0) return { ok: false };
  const size = Number.isSafeInteger(log.size) ? log.size : log.next;
  const more = log.next < size;
  return {
    ok: true, text: typeof log.text === 'string' ? log.text : '', next: log.next,
    reset: log.reset === true, exists: log.exists !== false, more, done: !live && !more,
  };
}

// The DOM keeps the last LOG_DOM_CAP characters; the full log stays on disk.
const LOG_DOM_CAP = 200000;
function appendCapped(current, chunk, cap) {
  const max = Number.isInteger(cap) && cap > 0 ? cap : LOG_DOM_CAP;
  const joined = String(current == null ? '' : current) + String(chunk == null ? '' : chunk);
  if (joined.length <= max) return { text: joined, dropped: 0 };
  let cut = joined.length - max;
  const code = joined.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1; // never begin on the low half of a pair
  return { text: joined.slice(cut), dropped: cut };
}

function shouldStick(scrollTop, clientHeight, scrollHeight) {
  return scrollHeight - (scrollTop + clientHeight) <= 24;
}

// Every answer the dispatch and cancel routes give, in the console's language.
// Losing the claim to the scheduler is ok:true - the order runs either way.
function orderActionOutcome(action, status, body) {
  const err = body && typeof body.error === 'string' ? body.error : '';
  const verb = action === 'cancel' ? '取消' : '派发';
  if (status === 0) return { ok: false, text: '无法连接服务器' };
  if (status === 200) return { ok: true, text: action === 'cancel' ? '已发出取消' : '已派发，等它开始运行' };
  if (status === 404) return { ok: false, text: '这一单不存在了' };
  if (status === 409 && /already being dispatched/.test(err)) return { ok: true, text: '调度器已经领走了这一单' };
  if (status === 409 && body && body.order && body.order.status) {
    return { ok: false, text: `这一单已经是「${orderStatusText(body.order.status)}」了` };
  }
  if (status === 409) {
    const m = /^order is already (\w+)$/.exec(err);
    return { ok: false, text: m ? `这一单已经是「${orderStatusText(m[1])}」了` : `${verb}不了：${err || '状态冲突'}` };
  }
  if (status === 429) return { ok: false, text: `同时运行的 agent 已满，稍后再试（${err}）` };
  return { ok: false, text: `${verb}失败：${err || `HTTP ${status}`}` };
}

function goalSubmitOutcome(status, body) {
  const err = body && typeof body.error === 'string' ? body.error : '';
  if (status === 200 && body && body.goal && body.goal.id) return { ok: true, goal: body.goal, text: '已交给 PM' };
  if (status === 0) return { ok: false, text: '无法连接服务器，目标没有提交' };
  if (status === 400 && /^text is required/.test(err)) return { ok: false, text: '目标不能为空' };
  if (status === 400 && /^text is too long/.test(err)) return { ok: false, text: `目标太长：${err}` };
  if (status === 404) return { ok: false, text: '这个项目不存在了（可能在别的标签页里被移除）' };
  if (status === 413) return { ok: false, text: '目标太长，请求被拒绝' };
  if (status === 429) return { ok: false, text: `同时运行的 agent 已满，稍后再试（${err}）` };
  return { ok: false, text: `提交失败：${err || `HTTP ${status}`}` };
}

// Plan 2d changed `done`: every chain's latest attempt was VERIFIED. `failed`
// is either a plan that could not be made or a rejection with no retry
// coming - goal.error says which. `stalled` is live and means "needs you".
const GOAL_STATUS_TEXT = {
  planning: 'PM 拆解中', planned: '已拆解 · 待运行', running: '运行中',
  stalled: '停住了 · 需要你处理', done: '完成 · 每单都已验收', failed: '失败',
};
function goalStatusText(status, goal) {
  if (status === 'planned' && goal && goal.held === true) return '已拆解 · 等你放行';
  return Object.prototype.hasOwnProperty.call(GOAL_STATUS_TEXT, status)
    ? GOAL_STATUS_TEXT[status]
    : `未知状态（${String(status)}）`;
}

// POST /api/orders creates AND dispatches - no PM, no scheduler, no review.
// The modal says so before the click, and says what it touches.
function oneOffNote(project) {
  if (!project) return '先在左侧选一个项目，才能把 Skill 派给它。';
  const where = project.kind === 'git'
    ? '在一个独立的 git worktree 里运行'
    : '直接改动这个目录（普通目录无法隔离）';
  return `会立刻在「${project.name || project.path}」里${where}。不经过 PM，也不经过调度器。` +
    '路径口令里的 SKILL.md 在项目外，agent 读不到时改用「完整口令」。';
}

// What a board row says about where an order is. A queued order that dispatch
// already holds (GET /api/orders' `claimed`, plan 3 Task 0) is STARTING - its
// worktree is being made - and must not read as waiting in line.
function orderRowStatus(order, budget) {
  const st = order && order.status;
  if (st === 'queued' && order.claimed === true) return { text: '正在启动', dot: 'running' };
  const f = failureView(order, budget);
  const known = Object.prototype.hasOwnProperty.call(ORDER_STATUS_TEXT, st);
  return { text: f ? f.title : orderStatusText(st), dot: known ? st : 'unknown' };
}

// Inert in the browser: a classic script has no `module`, so the typeof guard
// short-circuits and the declarations above simply stay globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    esc, escAttr, railState, deleteOutcome,
    ORDER_SETTLED_STATES, GOAL_SETTLED_STATES, boardQuery, seqLabel, seqSpoken, orderTitle,
    fmtDuration, orderElapsed, orderStatusText, exitCodeText, failureView,
    BOARD_GROUPS, boardGroupKey, boardSortFor, groupOrders, localDayKey, ordersToday, boardSignature,
    boardState, goalOrderIds,
    schedulerView, reviewMode, budgetView, orderTransitions, announcement, logStep, LOG_DOM_CAP,
    appendCapped, shouldStick, orderActionOutcome, goalSubmitOutcome, goalStatusText, oneOffNote,
    orderRowStatus,
  };
}
