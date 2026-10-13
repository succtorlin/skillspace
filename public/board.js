// Board — plan 3, spec §8.2: the active project's orders grouped by status.
// Classic script; reads pure.js and icons.js globals; app.js calls into it
// only through the functions marked "called from app.js".
//
// POLLED, NOT STREAMED: see docs/plans/2026-10-12-board.md, "Live updates".

let board = {
  project: null, orders: null, goals: [], sched: null, prevSched: null,
  goalFilter: null, sig: '', okAt: 0, error: null, inFlight: false, timer: null, ticker: null,
};

function boardEl(id) { return document.getElementById(id); }

// Called from order-drawer.js, goal-panel.js and app.js.
function boardCurrent() { return board; }

function boardSetProject(project) {
  const same = !!board.project && !!project && board.project.id === project.id;
  board = same
    ? { ...board, project }
    : { ...board, project: project || null, orders: null, goals: [], goalFilter: null, sig: '', error: null, okAt: 0 };
  boardRenderHeader();
}

function boardRenderHeader() {
  const p = board.project;
  const v = p ? budgetView(p, board.orders || [], Date.now()) : null;
  boardEl('board-title').textContent = p ? (p.name || p.path) : '没有选中项目';
  boardEl('board-path').textContent = p ? p.path : '在左侧添加或选择一个项目。';
  boardEl('board-kind').textContent = p ? `${String(p.kind).toUpperCase()} · ${v.concurrency.value}` : '';
  boardEl('board-kind-why').textContent = p ? v.concurrency.note : '';
}

document.addEventListener('skillspace:project', (e) => boardSetProject(e.detail ? e.detail.project : null));
