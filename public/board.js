// Board — plan 3, spec §8.2: the active project's orders grouped by status.
// Classic script; reads pure.js and icons.js globals; app.js calls into it
// only through the functions marked "called from app.js".
//
// POLLED, NOT STREAMED: see docs/plans/2026-10-12-board.md, "Live updates".

let board = {
  project: null, orders: null, chains: {}, goals: [], sched: null, prevSched: null,
  goalFilter: null, sig: '', okAt: 0, error: null, inFlight: false, timer: null, ticker: null,
};

function boardEl(id) { return document.getElementById(id); }

// Called from order-drawer.js, goal-panel.js and app.js.
function boardCurrent() { return board; }

function boardSetProject(project) {
  const same = !!board.project && !!project && board.project.id === project.id;
  board = same
    ? { ...board, project }
    : { ...board, project: project || null, orders: null, chains: {}, goals: [], goalFilter: null, sig: '', error: null, okAt: 0 };
  boardRenderHeader();
  // A goal selected on another project must not survive the switch.
  if (!same && typeof goalPanelSelect === 'function') goalPanelSelect(null);
  boardRender();
  boardSchedule(0);
}

function boardRenderHeader() {
  const p = board.project;
  const v = p ? budgetView(p, board.orders || [], Date.now()) : null;
  boardEl('board-title').textContent = p ? (p.name || p.path) : '没有选中项目';
  boardEl('board-path').textContent = p ? p.path : '在左侧添加或选择一个项目。';
  boardEl('board-kind').textContent = p ? `${String(p.kind).toUpperCase()} · ${v.concurrency.value}` : '';
  boardEl('board-kind-why').textContent = p ? v.concurrency.note : '';
}

const BOARD_POLL_MS = 2000;

// { ok, status, body }. status 0 = no response at all (network / server down).
async function boardGetJson(url) {
  try {
    const r = await fetch(url);
    let body = null;
    try { body = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, body };
  } catch (_) {
    return { ok: false, status: 0, body: null };
  }
}
async function boardPostJson(url, payload) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, body };
  } catch (_) {
    return { ok: false, status: 0, body: null };
  }
}

function boardSchedule(delay) {
  clearTimeout(board.timer);
  if (!board.project || document.hidden) return;
  board = { ...board, timer: setTimeout(boardPoll, delay) };
}

// Called from the drawer and goal panel after an action.
function boardRefresh() { boardSchedule(0); }

async function boardPoll() {
  const project = board.project;
  const q = project && boardQuery(project.id);
  if (!q || board.inFlight) return;
  board = { ...board, inFlight: true };
  const [o, g, s] = await Promise.all([
    boardGetJson(q),
    boardGetJson('/api/goals?project=' + encodeURIComponent(project.id)),
    boardGetJson('/api/scheduler'),
  ]);
  board = { ...board, inFlight: false };
  // Standing question 5: the user may have picked another project while this
  // was in flight. Its answer is about a board no longer on screen.
  if (!board.project || board.project.id !== project.id) return boardSchedule(0);
  boardApply(o, g, s);
  boardSchedule(BOARD_POLL_MS);
}

function boardApply(o, g, s) {
  const st = boardState(o.ok, o.body, null);
  const goals = g.ok && g.body && Array.isArray(g.body.goals) ? g.body.goals : board.goals;
  const sched = s.ok && s.body ? s.body : null;
  if (st.kind === 'error') {
    const why = st.message || (o.status ? `HTTP ${o.status}` : '无法连接服务器');
    board = { ...board, error: why, prevSched: board.sched, sched, goals };
  } else {
    const transitions = board.orders ? orderTransitions(board.orders, st.orders) : [];
    // chains: plan 2d's derived attempt chains, BESIDE the records
    // ({ [orderId]: chain | null }). Kept as sent; Task 17 renders them.
    const chains = o.body && o.body.chains && typeof o.body.chains === 'object' ? o.body.chains : {};
    board = { ...board, orders: st.orders, chains, error: null, okAt: Date.now(), prevSched: board.sched, sched, goals };
    const msg = announcement(transitions);
    if (msg) boardEl('board-live').textContent = msg;
  }
  boardRender();
  if (typeof goalPanelRender === 'function') goalPanelRender();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(board.timer);
  else boardSchedule(0);
});

function boardStateBlock(title, detail, action) {
  const btn = {
    retry: '<button type="button" class="btn" data-act="retry">立即重试</button>',
    compose: '<button type="button" class="btn" data-act="compose">去写目标</button>',
    'clear-filter': '<button type="button" class="btn" data-act="clear-filter">清除筛选</button>',
  }[action] || '';
  return `<div class="bd-state"><div class="bd-state-title">${esc(title)}</div><div>${esc(detail)}</div>${btn}</div>`;
}

function boardSkeleton() {
  return '<p class="srOnly" role="status">读取订单…</p>' +
    '<div class="bd-skel" aria-hidden="true"><span></span><span></span><span></span></div>';
}

function boardStaleBanner() {
  const at = board.okAt ? new Date(board.okAt).toLocaleTimeString() : '';
  return `<div class="bd-stale" role="alert"><span>订单读取失败（${esc(board.error)}）。下面是 ${esc(at)} 的数据，2 秒后重试。</span>` +
    '<button type="button" class="btn" data-act="retry">立即重试</button></div>';
}

function boardRowHtml(o) {
  const elapsed = orderElapsed(o, Date.now());
  const rs = orderRowStatus(o, board.project && board.project.budget);
  const dur = o.status === 'queued' ? '—' : elapsed === null ? '未运行' : fmtDuration(elapsed);
  const live = o.status === 'running' && o.startedAt ? ` data-started="${escAttr(o.startedAt)}"` : '';
  return `<li><button type="button" class="bd-row" data-order-id="${escAttr(o.id)}">` +
    `<span class="seq">${esc(seqLabel(o))}</span>` +
    `<span class="bd-title">${esc(orderTitle(o))}</span>` +
    `<span class="bd-agent">${esc(o.agent || '—')}</span>` +
    `<span class="bd-status"><span class="sdot" data-state="${escAttr(rs.dot)}" aria-hidden="true"></span>${esc(rs.text)}</span>` +
    `<span class="bd-dur"${live}>${esc(dur)}</span>` +
    '</button></li>';
}

function boardGroupHtml(g) {
  const hid = 'bd-g-' + g.key;
  return `<section class="bd-group" aria-labelledby="${hid}">` +
    `<h3 class="bd-group-head" id="${hid}"><span class="sdot" data-state="${escAttr(g.key)}" aria-hidden="true"></span>` +
    `${esc(g.label)}<span class="bd-n">${String(g.orders.length)}</span></h3>` +
    `<ul class="bd-rows">${g.orders.map(boardRowHtml).join('')}</ul></section>`;
}

function boardRender() {
  boardRenderHeader();
  if (typeof boardRenderSched === 'function') boardRenderSched();
  if (typeof boardRenderBudget === 'function') boardRenderBudget();
  const host = boardEl('board-groups');
  if (!host) return;
  const segN = boardEl('seg-board-n');
  if (segN) {
    const active = (board.orders || []).filter((o) => o.status === 'running' || o.status === 'queued').length;
    segN.textContent = active ? String(active) : '';
  }
  if (!board.project) {
    board = { ...board, sig: '' };
    host.innerHTML = boardStateBlock('先在左侧选一个项目', '看板显示的是当前项目的订单。', null);
    return;
  }
  if (board.orders === null) {
    board = { ...board, sig: '' };
    host.innerHTML = board.error ? boardStateBlock('订单读取失败', board.error, 'retry') : boardSkeleton();
    boardWire(host);
    return;
  }
  const ids = board.goalFilter ? goalOrderIds(board.goals, board.goalFilter) : null;
  const st = boardState(true, { orders: board.orders }, ids);
  const sig = [boardSignature(st.orders), st.kind, board.goalFilter || '', board.error ? 'stale' : ''].join('#');
  // Standing question 4: an identical poll must not destroy the focused row.
  if (sig === board.sig) return;
  board = { ...board, sig };
  const focused = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.orderId : null;
  const banner = board.error ? boardStaleBanner() : '';
  if (st.kind === 'empty') {
    host.innerHTML = banner + boardStateBlock('这个项目还没有订单',
      '在上面说一个目标，PM 会把它拆成订单；也可以去「技能」里挑一个 Skill 派给这个项目。', 'compose');
  } else if (st.kind === 'filtered') {
    host.innerHTML = banner + boardStateBlock('这个目标下还没有订单', 'PM 拆解完成前，目标下没有订单。', 'clear-filter');
  } else {
    host.innerHTML = banner + groupOrders(st.orders).map(boardGroupHtml).join('');
  }
  boardWire(host);
  if (focused) {
    const row = host.querySelector(`[data-order-id="${CSS.escape(focused)}"]`);
    if (row) row.focus();
  }
  boardTickerSync();
}

function boardWire(host) {
  host.querySelectorAll('.bd-row').forEach((el) =>
    el.addEventListener('click', () => openOrderDrawer(el.dataset.orderId)));
  host.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => {
    const act = el.dataset.act;
    if (act === 'retry') boardRefresh();
    if (act === 'compose') { const t = boardEl('goal-text'); if (t) t.focus(); }
    if (act === 'clear-filter') boardClearFilter();
  }));
}

// The filter and the selected goal are one fact shown in two places; clearing
// one must clear both, or the goal stays highlighted over an unfiltered board.
function boardClearFilter() {
  if (typeof goalPanelSelect === 'function') goalPanelSelect(null);
  else boardSetGoalFilter(null);
}

// Called from goal-panel.js.
function boardSetGoalFilter(goalId) {
  board = { ...board, goalFilter: goalId || null };
  const f = boardEl('board-filter');
  const goal = goalId ? board.goals.find((x) => x.id === goalId) : null;
  if (f) {
    f.hidden = !goal;
    f.innerHTML = goal
      ? `<span>只看目标：${esc(String(goal.text).split('\n')[0].slice(0, 60))}</span><button type="button" class="btn ghost" data-act="clear-filter">清除筛选</button>`
      : '';
    f.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', boardClearFilter));
  }
  boardRender();
}

// Running durations tick every second WITHOUT re-rendering the rows.
function boardTickerSync() {
  const any = !!document.querySelector('.bd-groups .bd-dur[data-started]');
  if (any && !board.ticker) board = { ...board, ticker: setInterval(boardTick, 1000) };
  if (!any && board.ticker) { clearInterval(board.ticker); board = { ...board, ticker: null }; }
}
function boardTick() {
  const now = Date.now();
  document.querySelectorAll('.bd-groups .bd-dur[data-started]').forEach((el) => {
    const t = Date.parse(el.dataset.started);
    el.textContent = Number.isFinite(t) ? fmtDuration(now - t) : '—';
  });
}

document.addEventListener('skillspace:project', (e) => boardSetProject(e.detail ? e.detail.project : null));
