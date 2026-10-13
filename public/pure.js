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

// Inert in the browser: a classic script has no `module`, so the typeof guard
// short-circuits and the declarations above simply stay globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    esc, escAttr, railState, deleteOutcome,
    ORDER_SETTLED_STATES, GOAL_SETTLED_STATES, boardQuery, seqLabel, seqSpoken, orderTitle,
    fmtDuration, orderElapsed, orderStatusText, exitCodeText, failureView,
    BOARD_GROUPS, boardGroupKey, boardSortFor, groupOrders, localDayKey, ordersToday, boardSignature,
    boardState, goalOrderIds,
  };
}
