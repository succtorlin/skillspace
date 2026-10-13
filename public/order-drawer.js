// Order drawer — spec §8.3: "extends the current run drawer". Same #run
// element and the same Escape/close contract app.js gives it, plus an order
// mode: facts, failure, prompt, acceptance, actions, and the log.
//
// The log is polled by byte offset (GET /api/orders/:id/log?from=N) - spec §7
// said "SSE while running, file when finished"; one mechanism serves both,
// and plan 3's "Live updates" says why.
//
// The log <pre> keeps role="log" but is set aria-live="off" in order mode: an
// agent printing a line a second would otherwise talk over everything. Status
// changes are announced once, through #run-status.

const DRAWER_POLL_MS = 1000;
// `first`: the next log read is the first for this order, so it asks for the
// tail rather than byte 0. `skipped`: bytes before the tail that were never
// fetched.
let drawer = { id: null, order: null, chain: null, from: 0, first: true, skipped: 0, dropped: 0, timer: null, pending: null, gen: 0 };

function drawerEl(id) { return document.getElementById(id); }

function drawerIsOpenFor(id) {
  const run = drawerEl('run');
  return !!run && run.style.display !== 'none' && run.dataset.orderId === id;
}

// Called from board.js and goal-panel.js.
function openOrderDrawer(id) {
  if (!id) return;
  if (typeof skillRunLive === 'function' && skillRunLive()) {
    askConfirm({
      title: '切换到订单会终止正在运行的 Skill',
      body: '抽屉里有一个本地 Skill 正在运行。切换过去会断开它的输出流，服务器随即终止那个 agent。',
      target: '',
      note: '',
      okText: '终止并切换',
      onOk: () => { stopSkillRun(); showOrder(id); },
    });
    return;
  }
  showOrder(id);
}

async function showOrder(id) {
  const run = drawerEl('run');
  clearTimeout(drawer.timer);
  const gen = drawer.gen + 1;
  drawer = { id, order: null, chain: null, from: 0, first: true, skipped: 0, dropped: 0, timer: null, pending: null, gen };
  run.dataset.orderId = id;
  run.style.display = 'flex';
  drawerEl('run-cmd').hidden = true;
  drawerEl('run-suffix').hidden = true;
  drawerEl('ord-meta').hidden = false;
  const out = drawerEl('run-out');
  out.textContent = '';
  out.setAttribute('aria-live', 'off');
  drawerEl('ord-log-note').textContent = '';
  drawerEl('run-skill').textContent = '读取订单…';
  drawerEl('run-status').textContent = '';
  const r = await boardGetJson('/api/orders/' + encodeURIComponent(id));
  if (drawer.gen !== gen) return; // Standing question 5
  if (!r.ok || !r.body || !r.body.order) {
    drawerEl('run-skill').textContent = r.status === 404 ? '这一单不存在了' : '订单读取失败';
    drawerEl('run-status').textContent = r.status === 404 ? '' : '关掉抽屉再点一次试试';
    drawerEl('ord-meta').hidden = true;
    return;
  }
  // Plan 2d: the chain arrives BESIDE the record (null when it cannot be
  // derived). Kept for the attempt history (Task 17).
  drawer = { ...drawer, chain: r.body.chain || null };
  drawerRenderOrder(r.body.order);
  setTimeout(() => { if (drawer.gen === gen) drawerEl('run-title').focus(); }, 30);
  drawerPollLog(gen);
}

function drawerBudgetFor(order) {
  const p = boardCurrent().project;
  return p && p.id === order.projectId ? p.budget : null;
}

function drawerRenderOrder(order) {
  drawer = { ...drawer, order };
  const budget = drawerBudgetFor(order);
  const f = failureView(order, budget);
  // A one-off order has no seq; "·· · title" would read as noise.
  drawerEl('run-skill').textContent = Number.isInteger(order.seq) && order.seq >= 0
    ? `${seqLabel(order)} · ${orderTitle(order)}` : orderTitle(order);
  const st = drawerEl('run-status');
  st.textContent = f ? f.title : orderStatusText(order.status);
  const live = order.status === 'queued' || order.status === 'running';
  st.className = 'run-status' + (live ? '' : f && f.kind !== 'cancelled' ? ' err' : ' done');

  const elapsed = orderElapsed(order, Date.now());
  const limit = budget && Number.isFinite(budget.orderTimeoutMs) ? fmtDuration(budget.orderTimeoutMs) : null;
  const facts = [
    ['状态', `<span class="sdot" data-state="${escAttr(order.status || 'unknown')}" aria-hidden="true"></span>${esc(orderStatusText(order.status))}`],
    ['Agent', esc(order.agent || '尚未分配')],
    ['退出码', esc(exitCodeText(order))],
    ['验收', (() => {
      const v = verdictView(order);
      if (!v) {
        return esc(order.status === 'cancelled' || order.status === 'interrupted' || (order.status === 'failed' && !order.startedAt)
          ? '没有结果可验收' : '还没有结果');
      }
      return boardVerdictBadge(order);
    })()],
    ['用时', `<span data-elapsed>${esc(elapsed === null ? '未运行' : fmtDuration(elapsed))}</span>` +
      (order.status === 'running' && limit ? ` <span class="ord-limit">/ 上限 ${esc(limit)}</span>` : '')],
    ['工作目录', `<span class="ord-path">${esc(order.cwd || '尚未创建')}</span>`],
  ];
  drawerEl('ord-facts').innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  const fb = drawerEl('ord-failure');
  fb.hidden = !f;
  if (f) {
    fb.dataset.kind = f.kind;
    fb.innerHTML = `<strong class="ord-failure-title">${esc(f.title)}</strong><p>${esc(f.detail)}</p>`;
  }
  drawerRenderVerdict(order);
  drawerRenderAttempts(order);
  drawerEl('ord-prompt').textContent = order.prompt || '';
  drawerEl('ord-prompt-n').textContent = `· ${String(Array.from(order.prompt || '').length)} 字`;
  drawerEl('ord-acceptance').textContent = order.acceptance ||
    '没有验收标准。一次性订单可以不填；PM 拆出的订单都应该有。';
  if (typeof drawerRenderActions === 'function') drawerRenderActions(order);
}

async function drawerRefreshOrder(gen) {
  const id = drawer.id;
  const r = await boardGetJson('/api/orders/' + encodeURIComponent(id));
  if (drawer.gen !== gen || !r.ok || !r.body || !r.body.order) return;
  const changed = !drawer.order || drawer.order.status !== r.body.order.status;
  drawer = { ...drawer, chain: r.body.chain || null };
  if (changed) drawer = { ...drawer, pending: null };
  drawerRenderOrder(r.body.order);
  if (changed) boardRefresh();
}

function drawerLogNote(step, status) {
  const parts = [];
  if (!step.exists) {
    // The record, not just the log route's status: whether it ever started
    // decides the wording (pure.noLogText).
    parts.push(noLogText({ ...(drawer.order || {}), status }));
  }
  if (drawer.skipped > 0) {
    const kb = Math.max(1, Math.round(drawer.skipped / 1024));
    parts.push(`只取了日志末尾，前面约 ${String(kb)} KB 没有加载；完整日志在 SkillSpace 数据目录的 logs/${drawer.id}.log。`);
  } else if (drawer.dropped > 0) {
    // Under a thousand, "约 0 千字" says nothing was dropped: count exactly.
    const n = drawer.dropped;
    const amount = n < 1000 ? `${String(n)} 字` : `约 ${String(Math.round(n / 1000))} 千字`;
    parts.push(`前面 ${amount}已省略；完整日志在 SkillSpace 数据目录的 logs/${drawer.id}.log。`);
  }
  if (step.more) parts.push('正在追上日志…');
  return parts.join(' ');
}

async function drawerPollLog(gen) {
  if (drawer.gen !== gen || !drawerIsOpenFor(drawer.id)) return;
  const id = drawer.id;
  const r = await boardGetJson(orderLogQuery(id, drawer.from, drawer.first));
  if (drawer.gen !== gen || !drawerIsOpenFor(id)) return;
  const status = r.body && r.body.status;
  const step = r.ok ? logStep(r.body, status === 'queued' || status === 'running') : { ok: false };
  const note = drawerEl('ord-log-note');
  if (!step.ok) {
    note.textContent = r.status === 404 ? '这一单不存在了。' : '日志读取失败，1 秒后重试。';
    if (r.status !== 404) drawer = { ...drawer, timer: setTimeout(() => drawerPollLog(gen), DRAWER_POLL_MS) };
    return;
  }
  const out = drawerEl('run-out');
  const stick = shouldStick(out.scrollTop, out.clientHeight, out.scrollHeight);
  if (drawer.first) {
    // The tail read: whatever it skipped was never fetched.
    const from = r.body && r.body.log && Number.isSafeInteger(r.body.log.from) ? r.body.log.from : 0;
    drawer = { ...drawer, first: false, skipped: from };
  }
  if (step.reset) { out.textContent = ''; drawer = { ...drawer, dropped: 0, skipped: 0 }; }
  if (step.text) {
    const capped = appendCapped(out.textContent, step.text, LOG_DOM_CAP);
    out.textContent = capped.text;
    drawer = { ...drawer, dropped: drawer.dropped + capped.dropped };
  }
  drawer = { ...drawer, from: step.next };
  if (stick) out.scrollTop = out.scrollHeight;
  note.textContent = drawerLogNote(step, status);
  drawerTickElapsed();
  if (!drawer.order || status !== drawer.order.status) await drawerRefreshOrder(gen);
  // Settled and drained: no more log will arrive. A verdict still may (plan
  // 2d judges AFTER the order settles, and never touches its status), so an
  // order awaiting or under judgement keeps its record refreshing.
  if (step.done) { drawerWatchVerdict(gen); return; }
  if (drawer.gen !== gen) return;
  // While catching up on a long log, do not wait a full second between slices.
  drawer = { ...drawer, timer: setTimeout(() => drawerPollLog(gen), step.more ? 0 : DRAWER_POLL_MS) };
}

// Closing the drawer (×, Escape) stops the poll and, because the board row
// that opened it may have been re-rendered since, puts focus back on the row
// with the same id rather than leaving it on <body>.
new MutationObserver(() => {
  const run = drawerEl('run');
  if (run.style.display !== 'none' || !run.dataset.orderId) return;
  const id = run.dataset.orderId;
  clearTimeout(drawer.timer);
  drawer = { ...drawer, gen: drawer.gen + 1, timer: null };
  delete run.dataset.orderId;
  // Focus still INSIDE the now-hidden drawer counts as lost: the browser does
  // not blur a node it has just hidden until the next style recalc, so at
  // this moment activeElement can still be the drawer's title rather than
  // <body> - measured, and it left the keyboard user on <body>.
  const active = document.activeElement;
  if (!active || active === document.body || run.contains(active)) {
    const row = document.querySelector(`.bd-row[data-order-id="${CSS.escape(id)}"]`);
    if (row) row.focus();
  }
}).observe(document.getElementById('run'), { attributes: true, attributeFilter: ['style'] });

// The 用时 fact of a running order moves every log poll (once a second)
// without re-rendering the facts - a re-render would also rebuild the
// failure block and the actions under a keyboard user.
function drawerTickElapsed() {
  const el = document.querySelector('#ord-facts [data-elapsed]');
  const o = drawer.order;
  if (!el || !o || o.status !== 'running') return;
  const ms = orderElapsed(o, Date.now());
  el.textContent = ms === null ? '未运行' : fmtDuration(ms);
}

function drawerRenderActions(order) {
  const d = drawerEl('ord-dispatch');
  const c = drawerEl('ord-cancel');
  const live = order.status === 'queued' || order.status === 'running';
  d.hidden = order.status !== 'queued';
  d.disabled = drawer.pending === 'dispatch';
  d.setAttribute('aria-busy', drawer.pending === 'dispatch' ? 'true' : 'false');
  d.textContent = drawer.pending === 'dispatch' ? '派发中…' : '立即派发';
  c.hidden = !live;
  c.disabled = drawer.pending === 'cancel';
  c.setAttribute('aria-busy', drawer.pending === 'cancel' ? 'true' : 'false');
  c.textContent = drawer.pending === 'cancel' ? '正在终止…' : order.status === 'running' ? '终止运行' : '取消这一单';
  // Plan 2d's two doors. Offered only where the server would accept them
  // (retryOffer / verdictRetryOffer mirror its refusals); it still decides.
  const b = boardCurrent();
  const goal = order.goalId ? (b.goals || []).find((g) => g && g.id === order.goalId) || null : null;
  const r = drawerEl('ord-retry');
  r.hidden = !retryOffer(order, drawer.chain, goal);
  r.disabled = drawer.pending === 'retry';
  r.setAttribute('aria-busy', drawer.pending === 'retry' ? 'true' : 'false');
  r.textContent = drawer.pending === 'retry' ? '新建中…' : '重试（新建一单）';
  const vr = drawerEl('ord-verdict-retry');
  const picker = document.getElementById('agent');
  const installed = picker ? [...picker.options].map((o) => o.value).filter(Boolean) : [];
  const offer = verdictRetryOffer(order, goal, b.sched, installed, drawer.chain);
  vr.hidden = !offer;
  vr.disabled = drawer.pending === 'verdict';
  vr.textContent = drawer.pending === 'verdict' ? '交给 PM…' : offer ? offer.label : '重新验收';
}

// Called from goal-panel.js too. Dispatch spawns a credentialed agent - one
// door, this one, used by both places that offer it.
async function dispatchOrder(id) {
  const agent = document.getElementById('agent');
  const r = await boardPostJson(`/api/orders/${encodeURIComponent(id)}/dispatch`,
    agent && agent.value ? { agent: agent.value } : {});
  const out = orderActionOutcome('dispatch', r.status, r.body);
  toast(out.text, out.ok ? undefined : 'error');
  boardRefresh();
  return out;
}

drawerEl('ord-dispatch').addEventListener('click', async () => {
  const order = drawer.order;
  if (!order || drawer.pending) return;
  const gen = drawer.gen;
  drawer = { ...drawer, pending: 'dispatch' };
  drawerRenderActions(order);
  const out = await dispatchOrder(order.id);
  if (drawer.gen !== gen) return;
  if (!out.ok) drawer = { ...drawer, pending: null };
  drawerRenderActions(drawer.order);
  // The route answers with the record still `queued` (runOrder marks it
  // running after `worktree add`); the log poll's status check clears pending.
  // A backstop, so a dispatch that never moves does not leave the button dead.
  setTimeout(() => {
    if (drawer.gen === gen && drawer.pending === 'dispatch') {
      drawer = { ...drawer, pending: null };
      drawerRenderActions(drawer.order);
    }
  }, 10000);
});

drawerEl('ord-cancel').addEventListener('click', () => {
  const order = drawer.order;
  if (!order || drawer.pending) return;
  const running = order.status === 'running';
  askConfirm({
    title: running ? `终止${seqSpoken(order)}` : `取消${seqSpoken(order)}`,
    body: running
      ? 'agent 会先收到 SIGTERM，5 秒后仍未退出就 SIGKILL。这一单记为「已取消」，不会自动重跑。'
      : '它还没开始运行。取消后记为「已取消」，调度器不会再领走它，也不能恢复。',
    target: orderTitle(order),
    note: '',
    okText: running ? '终止' : '取消这一单',
    onOk: () => drawerCancel(order.id),
  });
});

async function drawerCancel(id) {
  const gen = drawer.gen;
  drawer = { ...drawer, pending: 'cancel' };
  drawerRenderActions(drawer.order);
  const r = await boardPostJson(`/api/orders/${encodeURIComponent(id)}/cancel`, {});
  const out = orderActionOutcome('cancel', r.status, r.body);
  toast(out.text, out.ok ? undefined : 'error');
  if (drawer.gen !== gen) return;
  // A running order is only SIGNALLED; it settles when the process exits, and
  // the log poll sees that. Pending stays until then. A refusal clears it now.
  if (!out.ok) drawer = { ...drawer, pending: null };
  if (drawer.order) drawerRenderActions(drawer.order);
  await drawerRefreshOrder(gen);
  boardRefresh();
}

// The verdict's reasons, under the facts: why it was rejected, why judging
// failed (with the PM's unreadable reply behind a disclosure), and why no
// retry is coming. Plan 2d's fields; absent on older records.
function drawerRenderVerdict(order) {
  const box = drawerEl('ord-verdict');
  const v = verdictView(order);
  const parts = [];
  if (v && v.detail && v.kind !== 'awaiting' && v.kind !== 'none') {
    parts.push(`<p><span class="ord-verdict-k">${esc(v.kind === 'verified' ? 'PM 的结论' : v.kind === 'rejected' ? '驳回理由' : '原因')}</span>${esc(v.detail)}</p>`);
  } else if (v && v.detail) {
    parts.push(`<p>${esc(v.detail)}</p>`);
  }
  if (typeof order.verdictRaw === 'string' && order.verdictRaw) {
    parts.push(`<details class="ord-sec"><summary>PM 的原始回复 <span class="cmd-chars">· ${String(order.verdictRaw.length)} 字</span></summary>` +
      `<pre class="ord-pre" tabindex="0" role="log" aria-label="PM 的原始回复">${esc(order.verdictRaw)}</pre></details>`);
  }
  if (typeof order.retryRefused === 'string' && order.retryRefused) {
    parts.push(`<p><span class="ord-verdict-k">不会再重试</span>${esc(order.retryRefused)}</p>`);
  }
  box.hidden = !parts.length;
  box.dataset.kind = v ? v.kind : '';
  box.innerHTML = parts.join('');
}

// The attempt history: every order in this order's chain (the server's
// `chain.ids`, oldest first), each one click away. Orders the board has not
// loaded are listed by number only.
function drawerRenderAttempts(order) {
  const box = drawerEl('ord-attempts');
  const info = attemptInfo(drawer.chain);
  const ids = drawer.chain && Array.isArray(drawer.chain.ids) ? drawer.chain.ids : [];
  if (!info || ids.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  const byId = new Map((boardCurrent().orders || []).map((o) => [o.id, o]));
  const root = byId.get(drawer.chain.rootId) || null;
  box.hidden = false;
  box.innerHTML = `<div class="ord-attempts-head">${esc(attemptLabel(info, root))}</div><ol class="ord-attempt-list">` +
    ids.map((id, i) => {
      const o = id === order.id ? order : byId.get(id);
      const v = o ? verdictView(o) : null;
      const f = o ? failureView(o, null) : null;
      const what = !o ? '记录不在这个看板上' : v ? v.label : f ? f.title : orderStatusText(o.status);
      const why = v && v.kind === 'rejected' && v.detail ? ` · ${v.detail}` : '';
      const me = id === order.id;
      return `<li><button type="button" class="ord-attempt${me ? ' is-on' : ''}" data-order-id="${escAttr(id)}"${me ? ' aria-current="true"' : ''}>` +
        `第 ${String(i + 1)} 次 · ${esc(what)}${esc(why)}</button></li>`;
    }).join('') + '</ol>';
  box.querySelectorAll('.ord-attempt').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.orderId !== drawer.id) openOrderDrawer(el.dataset.orderId);
  }));
}

const DRAWER_VERDICT_POLL_MS = 2000;
function drawerWatchVerdict(gen) {
  const v = verdictView(drawer.order);
  if (!v || (v.kind !== 'judging' && v.kind !== 'awaiting')) return;
  drawer = { ...drawer, timer: setTimeout(async () => {
    if (drawer.gen !== gen || !drawerIsOpenFor(drawer.id)) return;
    const before = drawer.order && drawer.order.verdictState;
    await drawerRefreshOrder(gen);
    if (drawer.gen !== gen) return;
    if (drawer.order && drawer.order.verdictState !== before) boardRefresh();
    drawerWatchVerdict(gen);
  }, DRAWER_VERDICT_POLL_MS) };
}

drawerEl('ord-retry').addEventListener('click', async () => {
  const order = drawer.order;
  if (!order || drawer.pending) return;
  const gen = drawer.gen;
  drawer = { ...drawer, pending: 'retry' };
  drawerRenderActions(order);
  // Spec §7/§12: a NEW order with supersedes set; the original keeps its
  // status, log and verdict for good. 2d's retry does NOT dispatch: the loop
  // runs the new attempt, or with the loop off a human dispatches it.
  const r = await boardPostJson(`/api/orders/${encodeURIComponent(order.id)}/retry`, {});
  const out = retryOutcome('retry', r.status, r.body);
  if (drawer.gen !== gen) return;
  drawer = { ...drawer, pending: null };
  if (out.ok) {
    const s = boardCurrent().sched && boardCurrent().sched.scheduler;
    const n = out.chain && Number.isInteger(out.chain.attempt) ? `第 ${String(out.chain.attempt)} 次尝试` : '新的一次尝试';
    toast(`已新建${n}` + (s && s.running ? '，调度器会运行它' : '，它在排队：派发它才会运行'));
    boardRefresh();
    openOrderDrawer(out.order.id);
    return;
  }
  toast(out.text, 'error');
  drawerRenderActions(drawer.order);
  await drawerRefreshOrder(gen);
});

drawerEl('ord-verdict-retry').addEventListener('click', async () => {
  const order = drawer.order;
  if (!order || drawer.pending) return;
  const gen = drawer.gen;
  drawer = { ...drawer, pending: 'verdict' };
  drawerRenderActions(order);
  // The goal's PM judges by default. Only when that agent is no longer
  // installed is the topbar agent named - the way out 2d built this door for.
  const goal = (boardCurrent().goals || []).find((g) => g && g.id === order.goalId);
  const picker = document.getElementById('agent');
  const installed = picker ? [...picker.options].map((o) => o.value).filter(Boolean) : [];
  const body = goal && goal.pmAgent && !installed.includes(goal.pmAgent) && picker && picker.value ? { agent: picker.value } : {};
  const r = await boardPostJson(`/api/orders/${encodeURIComponent(order.id)}/verdict/retry`, body);
  const out = retryOutcome('verdict', r.status, r.body);
  if (drawer.gen !== gen) return;
  drawer = { ...drawer, pending: null };
  toast(out.text, out.ok ? undefined : 'error');
  await drawerRefreshOrder(gen);
  if (out.ok) { boardRefresh(); drawerWatchVerdict(gen); }
});

