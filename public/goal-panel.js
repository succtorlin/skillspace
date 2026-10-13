// Goal composer and goal panel — plan 3. State a goal against the active
// project, watch the PM decompose it, read the plan it produced.
//
// THE REVIEW HOLD (plan 3, Task 0). A goal can be posted with hold:true: the
// scheduler leaves its orders queued until POST /api/goals/:id/release. The
// composer's 先审后跑 box is ON by default - spec §4 makes the PM's plan
// something a human reads before it executes, and with the loop on (the
// default) an unheld plan starts within about a second of landing, before
// anyone could read it. The cost is one click (开始运行) per goal. The choice
// is remembered per browser. reviewMode() words the consequence either way.

const GOAL_LOG_POLL_MS = 1000;
const GOAL_HOLD_KEY = 'skillspace-goal-hold';
let goalPanel = { activeId: null, logFrom: 0, logGen: 0, logTimer: null, submitting: false, sig: '', detailSig: '', releasing: false };

// Per-viewer convenience only, so every storage access may throw (private
// window, blocked site data) and the default stands.
function goalHoldWanted() {
  const box = gpEl('goal-hold');
  return !!box && box.checked;
}
(function initGoalHold() {
  const box = document.getElementById('goal-hold');
  if (!box) return;
  try { const v = localStorage.getItem(GOAL_HOLD_KEY); if (v === '0' || v === '1') box.checked = v === '1'; } catch (_) {}
  box.addEventListener('change', () => {
    try { localStorage.setItem(GOAL_HOLD_KEY, box.checked ? '1' : '0'); } catch (_) {}
    goalPanelRender();
  });
})();

function gpEl(id) { return document.getElementById(id); }

// Called from board.js after every poll.
function goalPanelRender() {
  const b = boardCurrent();
  const mode = reviewMode(b.sched, goalHoldWanted());
  gpEl('goal-mode-note').textContent = b.project ? mode.note : '先在左侧选一个项目。';
  const submit = gpEl('goal-submit');
  if (!goalPanel.submitting) submit.textContent = mode.submitLabel;
  submit.disabled = !b.project || goalPanel.submitting;
  const agent = document.getElementById('agent');
  gpEl('goal-agent-note').textContent = agent && agent.value ? `PM：${agent.value}` : '没有可用的 agent';
  goalPanelRenderList(b);
  goalPanelRenderDetail(b);
}

function goalCounts(b, goal) {
  const ids = new Set(Array.isArray(goal.orderIds) ? goal.orderIds : []);
  const mine = (b.orders || []).filter((o) => ids.has(o.id));
  return { total: ids.size, settled: mine.filter((o) => ORDER_SETTLED_STATES.includes(o.status)).length, found: mine.length };
}

function goalPanelRenderList(b) {
  const host = gpEl('goal-list');
  if (!b.project || !b.goals.length) { host.innerHTML = ''; return; }
  const sig = b.goals.map((g) => `${g.id}:${g.status}:${g.held === true}:${(g.orderIds || []).length}`).join('|') +
    `#${goalPanel.activeId}#${boardSignature(b.orders || [])}`;
  if (sig === goalPanel.sig) return;
  goalPanel = { ...goalPanel, sig };
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.goalId : null;
  host.innerHTML = '<h3 class="bd-eyebrow gp-list-head">目标</h3><ul class="gp-list">' + b.goals.map((g) => {
    const c = goalCounts(b, g);
    const on = g.id === goalPanel.activeId;
    return `<li><button type="button" class="gp-goal${on ? ' is-on' : ''}" data-goal-id="${escAttr(g.id)}" aria-pressed="${on ? 'true' : 'false'}">` +
      `<span class="sdot" data-state="goal-${escAttr(g.status || 'unknown')}" aria-hidden="true"></span>` +
      `<span class="gp-goal-text">${esc(String(g.text || '').split('\n')[0])}</span>` +
      `<span class="gp-goal-status">${esc(goalStatusText(g.status, g))}${c.total ? ` · ${String(c.settled)}/${String(c.total)}` : ''}</span>` +
      '</button></li>';
  }).join('') + '</ul>';
  host.querySelectorAll('.gp-goal').forEach((el) => el.addEventListener('click', () =>
    goalPanelSelect(goalPanel.activeId === el.dataset.goalId ? null : el.dataset.goalId)));
  if (focused) {
    const el = host.querySelector(`[data-goal-id="${CSS.escape(focused)}"]`);
    if (el) el.focus();
  }
}

// Called from board.js's filter chip too.
function goalPanelSelect(goalId) {
  clearTimeout(goalPanel.logTimer);
  goalPanel = { ...goalPanel, activeId: goalId || null, logFrom: 0, logGen: goalPanel.logGen + 1, logTimer: null, sig: '', detailSig: '' };
  if (boardCurrent().goalFilter !== (goalId || null)) boardSetGoalFilter(goalId || null);
  goalPanelRender();
}

function goalPanelRenderDetail(b) {
  const host = gpEl('goal-detail');
  const goal = goalPanel.activeId ? b.goals.find((g) => g.id === goalPanel.activeId) : null;
  if (!goal) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  const ids = Array.isArray(goal.orderIds) ? goal.orderIds : [];
  const sig = `${goal.id}:${goal.status}:${goal.held === true}:${goalPanel.releasing}:${ids.join(',')}:${boardSignature((b.orders || []).filter((o) => ids.includes(o.id)))}:${planDispatchable(goal, b.sched)}:${reviewMode(b.sched, false).kind}`;
  if (sig === goalPanel.detailSig) return;
  goalPanel = { ...goalPanel, detailSig: sig };

  if (goal.status === 'planning') {
    // A start time, not "已用 Ns": this block renders once per status, so an
    // elapsed count would freeze at the moment it was drawn.
    const t = new Date(goal.createdAt);
    const since = Number.isNaN(t.getTime()) ? '' : `（${t.toLocaleTimeString()} 开始）`;
    // role="log": aria-label is prohibited on a bare <pre> (axe), and this is
    // a log - live off, the status line announces the outcome instead.
    host.innerHTML = `<p class="gp-note">PM 正在读项目并拆解${esc(since)}。它不会改文件。</p>` +
      '<pre id="gp-pmlog" class="ord-pre gp-pmlog" tabindex="0" role="log" aria-label="PM 的输出" aria-live="off"></pre>';
    // A re-render replaced the <pre>, so the log restarts from byte 0 under a
    // NEW generation - otherwise the old loop keeps appending at its offset
    // into an empty element and the first part of the PM's output is lost.
    clearTimeout(goalPanel.logTimer);
    goalPanel = { ...goalPanel, logGen: goalPanel.logGen + 1, logFrom: 0, logTimer: null };
    goalPanelPollLog(goalPanel.logGen);
    return;
  }
  // Two writers settle a goal `failed` (plan 2d): a plan that could not be
  // made (rawPlan kept, NO orders) or an order chain rejected with no retry
  // coming (orders exist). The first has no plan to show; the second shows
  // the plan under the failure, so the rejected step can be opened.
  const rewrite = '<button type="button" class="btn" data-act="rewrite">改写后重新提交</button>';
  const wireRewrite = () => {
    const btn = host.querySelector('[data-act="rewrite"]');
    if (btn) btn.addEventListener('click', () => {
      gpEl('goal-text').value = goal.text || '';
      gpEl('goal-text').focus();
    });
  };
  if (goal.status === 'failed' && !ids.length) {
    const raw = typeof goal.rawPlan === 'string' ? goal.rawPlan : '';
    host.innerHTML =
      `<div class="ord-failure" data-kind="goal"><strong class="ord-failure-title">拆解失败</strong><p>${esc(goal.error || '原因没有记录')}</p>` +
      '<p>不会自动重试：PM 拿不出可用的计划，通常是目标需要改窄或改写。</p></div>' +
      (raw ? `<details class="ord-sec"><summary>PM 原始输出 <span class="cmd-chars">· ${String(raw.length)} 字</span></summary><pre class="ord-pre" tabindex="0" role="log" aria-label="PM 原始输出">${esc(raw)}</pre></details>` : '') +
      rewrite;
    wireRewrite();
    return;
  }
  const rejected = goal.status === 'failed'
    ? `<div class="ord-failure" data-kind="goal"><strong class="ord-failure-title">失败：有订单被驳回，且不会再重试</strong><p>${esc(goal.error || '原因没有记录')}</p>` +
      `<p>目标已经结束，不能再在它下面重试。要继续，改写目标重新提交。</p>${rewrite}</div>`
    : '';
  const mode = reviewMode(b.sched, false);
  const canStep = planDispatchable(goal, b.sched);
  const held = goal.held === true && !GOAL_SETTLED_STATES.includes(goal.status);
  const byId = new Map((b.orders || []).map((o) => [o.id, o]));
  const plan = ids.map((id) => byId.get(id)).filter(Boolean)
    .sort((x, y) => (Number.isInteger(x.seq) ? x.seq : 1e9) - (Number.isInteger(y.seq) ? y.seq : 1e9));
  const missing = ids.length - plan.length;
  const lead = held
    ? '<div class="gp-held"><p><strong>计划已拆好，正在等你放行。</strong>读一遍每一步和它的验收标准；可以逐单派发，也可以一次放行全部。</p>' +
      `<button type="button" class="btn primary" data-act="release"${goalPanel.releasing ? ' disabled aria-busy="true"' : ''}>${goalPanel.releasing ? '放行中…' : '开始运行'}</button>` +
      (b.sched && b.sched.scheduler && b.sched.scheduler.running === false ? '<p class="gp-note">调度器关闭：放行只是解除暂停，订单仍要逐单派发。</p>' : '') + '</div>'
    : goal.status === 'stalled'
      ? '<p class="gp-note"><strong>停住了，需要你处理。</strong>没有订单在跑，但有一步的验收出错、被取消、被中断或没能启动。打开它，在抽屉里重试。</p>'
      : rejected || `<p class="gp-note">${esc(goalStatusText(goal.status, goal))}。${goal.status === 'planned' ? esc(mode.note) : ''}</p>`;
  host.innerHTML = lead +
    '<ol class="gp-plan">' + plan.map((o) => {
      const f = failureView(o, b.project && b.project.budget);
      const canDispatch = o.status === 'queued' && !o.claimed && canStep;
      return '<li class="gp-step">' +
        `<button type="button" class="gp-step-open" data-order-id="${escAttr(o.id)}"><span class="seq">${esc(seqLabel(o))}</span><span class="gp-step-title">${esc(orderTitle(o))}</span></button>` +
        `<span class="bd-status"><span class="sdot" data-state="${escAttr(o.status || 'unknown')}" aria-hidden="true"></span>${esc(f ? f.title : orderStatusText(o.status))}</span>` +
        `<p class="gp-accept"><span class="gp-accept-k">验收</span>${esc(o.acceptance || '（PM 没有给验收标准）')}</p>` +
        (canDispatch ? `<button type="button" class="btn gp-dispatch" data-dispatch="${escAttr(o.id)}">派发</button>` : '') +
        '</li>';
    }).join('') + '</ol>' +
    (missing > 0 ? `<p class="gp-note">还有 ${String(missing)} 单的记录读不到（可能是新创建、还没被轮询到，或已损坏）。</p>` : '');
  host.querySelectorAll('.gp-step-open').forEach((el) => el.addEventListener('click', () => openOrderDrawer(el.dataset.orderId)));
  wireRewrite();
  const rel = host.querySelector('[data-act="release"]');
  if (rel) rel.addEventListener('click', () => goalPanelRelease(goal));
  host.querySelectorAll('[data-dispatch]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true;
    el.textContent = '派发中…';
    const out = await dispatchOrder(el.dataset.dispatch);
    if (!out.ok) { el.disabled = false; el.textContent = '派发'; }
  }));
}

async function goalPanelPollLog(gen) {
  const id = goalPanel.activeId;
  if (!id || gen !== goalPanel.logGen) return;
  const r = await boardGetJson(`/api/goals/${encodeURIComponent(id)}/log?from=${String(goalPanel.logFrom)}`);
  if (gen !== goalPanel.logGen) return;
  if (r.status === 404) return; // the goal is gone; polling it forever helps nobody
  const pre = document.getElementById('gp-pmlog');
  const step = r.ok ? logStep(r.body, r.body && r.body.status === 'planning') : { ok: false };
  if (step.ok && pre) {
    const stick = shouldStick(pre.scrollTop, pre.clientHeight, pre.scrollHeight);
    // The placeholder is a marker, not log text: it must never be the head of
    // what the PM prints next.
    if (step.reset || pre.dataset.placeholder) { pre.textContent = ''; delete pre.dataset.placeholder; }
    if (step.text) pre.textContent = appendCapped(pre.textContent, step.text, LOG_DOM_CAP).text;
    if (!pre.textContent) { pre.textContent = '（PM 还没有输出）'; pre.dataset.placeholder = '1'; }
    if (stick) pre.scrollTop = pre.scrollHeight;
    goalPanel = { ...goalPanel, logFrom: step.next };
    if (step.done) { boardRefresh(); return; }
  }
  goalPanel = { ...goalPanel, logTimer: setTimeout(() => goalPanelPollLog(gen), GOAL_LOG_POLL_MS) };
}

gpEl('goal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = boardCurrent();
  const text = gpEl('goal-text').value.trim();
  const errEl = gpEl('goal-error');
  errEl.hidden = true;
  if (!b.project) return;
  if (!text) { errEl.textContent = '目标不能为空'; errEl.hidden = false; gpEl('goal-text').focus(); return; }
  goalPanel = { ...goalPanel, submitting: true };
  gpEl('goal-submit').textContent = '提交中…';
  gpEl('goal-submit').disabled = true;
  const agent = document.getElementById('agent');
  const r = await boardPostJson('/api/goals', {
    projectId: b.project.id, text, hold: goalHoldWanted(), ...(agent && agent.value ? { agent: agent.value } : {}),
  });
  goalPanel = { ...goalPanel, submitting: false };
  const out = goalSubmitOutcome(r.status, r.body);
  if (!out.ok) {
    // The text stays where it was: a failed submit never costs the user
    // what they typed.
    errEl.textContent = out.text;
    errEl.hidden = false;
    goalPanelRender();
    return;
  }
  gpEl('goal-text').value = '';
  boardAddGoal(out.goal);
  goalPanelSelect(out.goal.id);
  toast(out.text);
});

// One door for releasing a held goal. It starts nothing itself; with the loop
// on, the goal's queued orders run from its next tick.
async function goalPanelRelease(goal) {
  if (goalPanel.releasing) return;
  goalPanel = { ...goalPanel, releasing: true, detailSig: '' };
  goalPanelRender();
  const r = await boardPostJson(`/api/goals/${encodeURIComponent(goal.id)}/release`, {});
  const out = goalReleaseOutcome(r.status, r.body);
  goalPanel = { ...goalPanel, releasing: false, detailSig: '' };
  toast(out.text, out.ok ? undefined : 'error');
  if (out.ok && out.goal) boardAddGoal(out.goal);
  else boardRefresh();
  goalPanelRender();
  // The button the keyboard user pressed is gone; land on the plan.
  const first = document.querySelector('#goal-detail .gp-step-open');
  if (first) first.focus();
}

