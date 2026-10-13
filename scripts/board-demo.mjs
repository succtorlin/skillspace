#!/usr/bin/env node
// A throwaway SkillSpace for browser checks of the board (plan 3, Task 3).
//
//   node scripts/board-demo.mjs               scheduler OFF (review mode), port 4199
//   node scripts/board-demo.mjs --scheduler   scheduler ON
//   node scripts/board-demo.mjs --store DIR   reuse a store (restart → `interrupted`)
//   node scripts/board-demo.mjs --seed-verdicts   + plan 2d verdict records (fresh store only)
//
// The ONLY agent it can find is a shim in a fake $HOME/.local/bin, and that is
// asserted before anything is printed: PATH is /usr/bin:/bin and HOME is a
// temp dir, so the developer's real `claude` is unreachable by construction.
//
// What the shim does, keyed on the prompt it is handed:
//   PM prompt ("You are planning work")  sleeps 3s, then prints a 4-order plan
//     … containing DEMO-TOO-BIG          prints a 13-order plan (over the cap of 12)
//     … containing DEMO-GARBAGE          prints prose, no plan
//   DEMO-STREAM   40 lines, one a second, half of them Chinese
//   DEMO-EXIT3    one line, exit 3
//   DEMO-HANG     sleeps 600s (the git project's timeout is 8s → `timeout`)
//   anything else prints "done", exit 0
//   A VERDICT prompt (plan 2d's judge; it opens "You are reviewing one finished
//   work order.") is answered FIRST, because it embeds the order's own prompt:
//     … a retry carrying REVIEWER FEEDBACK   verified ("fixed")
//     … containing DEMO-REJECT               rejected ("edited the wrong file")
//     … containing DEMO-EXIT3                rejected ("it exited 3")
//     … containing DEMO-VERDICT-PROSE        prose, so the verdict errors
//     … anything else                        verified
//
// NEVER port 4177: that is where a real SkillSpace usually runs, and this
// script refuses it outright rather than racing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const schedulerOn = args.includes('--scheduler');
const storeArg = args.includes('--store') ? args[args.indexOf('--store') + 1] : null;
const port = process.env.PORT || '4199';
if (String(port) === '4177') {
  console.error('REFUSING: port 4177 belongs to a real SkillSpace. Pick another PORT.');
  process.exit(1);
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const SHIM = `#!/bin/sh
# The prompt is the LAST argument (after "--" for claude/codex).
for P; do :; done
case "$P" in
  *"You are reviewing one finished work order."*)
    case "$P" in
      *"REVIEWER FEEDBACK"*) echo '{"verdict":"verified","reason":"fixed: the feedback was addressed"}' ;;
      *DEMO-REJECT*) echo '{"verdict":"rejected","reason":"edited the wrong file"}' ;;
      *DEMO-EXIT3*) echo '{"verdict":"rejected","reason":"it exited 3 and did not do the work"}' ;;
      *DEMO-VERDICT-PROSE*) echo "I looked at it and I am not sure." ;;
      *) echo '{"verdict":"verified","reason":"the acceptance holds"}' ;;
    esac
    exit 0 ;;
  *"You are planning work"*)
    case "$P" in
      *DEMO-TOO-BIG*)
        i=0; printf '['
        while [ $i -lt 13 ]; do
          [ $i -gt 0 ] && printf ','
          printf '{"title":"part %s","prompt":"DEMO-OK part %s","acceptance":"the file exists"}' $i $i
          i=$((i+1))
        done
        printf ']\\n' ;;
      *DEMO-GARBAGE*) echo "I read the project but could not settle on a plan." ;;
      *) echo "reading the project…"; sleep 3; cat <<'JSON'
[{"title":"Stream a long log","prompt":"DEMO-STREAM","acceptance":"the log shows 40 numbered lines"},
 {"title":"Exit non-zero","prompt":"DEMO-EXIT3","acceptance":"never satisfiable: exits 3"},
 {"title":"Hang past the timeout","prompt":"DEMO-HANG","acceptance":"never satisfiable: hangs"},
 {"title":"Finish cleanly","prompt":"DEMO-OK","acceptance":"exits 0 and prints done"}]
JSON
      ;;
    esac ;;
  *DEMO-STREAM*) i=1; while [ $i -le 40 ]; do echo "line $i · 第 $i 行"; i=$((i+1)); sleep 1; done ;;
  *DEMO-EXIT3*) echo "about to fail on purpose"; exit 3 ;;
  *DEMO-HANG*) echo "hanging"; sleep 600 ;;
  *) echo "done"; exit 0 ;;
esac
`;

const home = tmp('skillspace-demo-home-');
const store = storeArg || tmp('skillspace-demo-store-');
const bin = path.join(home, '.local', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), SHIM, { mode: 0o755 });

const gitEnv = {
  GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid',
  GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid',
};
const env = {
  PATH: '/usr/bin:/bin', HOME: home, TMPDIR: os.tmpdir(),
  SKILLSPACE_HOME: store, SKILLSPACE_EXPERTS_FILE: path.join(store, 'experts.json'),
  SKILLSPACE_SCHEDULER: schedulerOn ? '1' : '0', PORT: port, ...gitEnv,
  ...(process.env.SKILLSPACE_SCHEDULER_INTERVAL_MS
    ? { SKILLSPACE_SCHEDULER_INTERVAL_MS: process.env.SKILLSPACE_SCHEDULER_INTERVAL_MS } : {}),
};

// stdout is piped (and echoed) rather than inherited: the server names the
// console-link file holding its per-boot API secret there, and this script
// needs the secret for its own API calls below. Every fetch sends it.
const server = spawn(process.execPath, ['server.js'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'inherit'] });
const base = `http://127.0.0.1:${port}`;
let secret = null;
let banner = '';
server.stdout.on('data', (c) => {
  process.stdout.write(c);
  if (secret) return;
  banner += c;
  // stdout is a pipe, so the server redacts the link and names the 0600
  // console-link file (under the demo's SKILLSPACE_HOME) that holds it.
  const m = banner.match(/console link: (.+)\n/);
  if (!m) return;
  const k = fs.readFileSync(m[1].trim(), 'utf8').match(/\/\?auth=([0-9a-f]{64})/);
  if (k) secret = k[1];
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => nativeFetch(url, {
  ...init, headers: { ...(init.headers || {}), ...(secret ? { 'X-SkillSpace-Auth': secret } : {}) },
});
const stop = () => { server.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const deadline = Date.now() + 15000;
for (;;) {
  try { if ((await fetch(base + '/api/config')).ok) break; } catch (_) {}
  if (server.exitCode !== null || Date.now() > deadline) { console.error('demo server did not start'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 100));
}
const cfg = await (await fetch(base + '/api/config')).json();
if (JSON.stringify(cfg.agents) !== '["claude"]') {
  console.error('REFUSING: the demo server sees agents other than the shim:', cfg.agents);
  stop();
  process.exit(1);
}

if (!storeArg) {
  const repo = tmp('skillspace-demo-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env, ...gitEnv } });
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['add', '.'], { cwd: repo, env: { ...process.env, ...gitEnv } });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo, env: { ...process.env, ...gitEnv } });
  const dir = tmp('skillspace-demo-dir-');
  const post = (body) => fetch(base + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  await post({ name: 'demo-git', path: repo, budget: { orderTimeoutMs: 8000 } });
  await post({ name: 'demo-dir', path: dir });
}

if (args.includes('--seed-verdicts')) {
  // Plan 2d's record shapes, written straight to the store so every verdict
  // state can be screenshotted side by side without waiting on a judge:
  // verified, exit-0-awaiting, rejected-then-retried (a chain of two),
  // an errored verdict with the PM's unreadable reply, and - under a second,
  // failed goal - a rejection with no retry coming.
  const projects = await (await fetch(base + '/api/projects')).json();
  const git = projects.projects.find((p) => p.name === 'demo-git');
  if (!git) { console.error('--seed-verdicts needs a fresh store (demo-git missing)'); stop(); process.exit(1); }
  const now = Date.now();
  const iso = (dt) => new Date(now - dt).toISOString();
  const V = { verdict: null, verdictReason: null, verdictState: null, verdictError: null, verdictRaw: null,
    verdictAgent: null, verdictLog: null, verdictRuns: 0, verdictStartedAt: null, verdictAt: null, retryRefused: null };
  const judged = (verdict, reason) => ({ verdict, verdictReason: reason, verdictState: 'judged', verdictAgent: 'claude',
    verdictRuns: 1, verdictStartedAt: iso(30000), verdictAt: iso(25000) });
  const rec = (id, goalId, over) => ({
    id, projectId: git.id, goalId, seq: 0, title: id, prompt: 'seeded', acceptance: 'seeded acceptance',
    agent: 'claude', cwd: null, status: 'succeeded', exitCode: 0, error: null, supersedes: null,
    createdAt: iso(60000), startedAt: iso(50000), finishedAt: iso(40000), ...V, ...over,
  });
  const g1 = 'goal-00000000000001-0000-seed-stalled';
  const g2 = 'goal-00000000000002-0000-seed-failed';
  const o = (n, tag) => `ord-0000000000000${n}-0000-seed-${tag}`;
  const seeds = [
    rec(o(1, 'verified'), g1, { title: 'Verified', seq: 0, acceptance: 'npm test passes', ...judged('verified', 'all acceptance checks pass') }),
    rec(o(2, 'awaiting'), g1, { title: 'Exit 0, awaiting a verdict', seq: 1, acceptance: 'the README names the new flag' }),
    rec(o(3, 'rejected'), g1, { title: 'Rejected, then retried', seq: 2, acceptance: 'only settings.js changes', ...judged('rejected', 'edited the wrong file') }),
    rec(o(4, 'retry'), g1, { title: 'Rejected, then retried', seq: 2, acceptance: 'only settings.js changes', supersedes: o(3, 'rejected'),
      createdAt: iso(20000), startedAt: iso(15000), finishedAt: iso(10000), ...judged('verified', 'fixed: only settings.js changed') }),
    rec(o(5, 'verdict-error'), g1, { title: 'The verdict could not be read', seq: 3, acceptance: 'the export button works',
      verdictState: 'error', verdictError: 'the reply carried no verdict', verdictRaw: 'I looked at it and I am not sure.',
      verdictAgent: 'claude', verdictRuns: 1, verdictStartedAt: iso(30000), verdictAt: iso(25000) }),
    rec(o(6, 'final'), g2, { title: 'Rejected with no retry coming', seq: 0, status: 'failed', exitCode: 3,
      acceptance: 'exits 0', ...judged('rejected', 'it exited 3 and did not do the work'), retryRefused: 'no attempts left (3 of 3)' }),
  ];
  const goal = (id, status, orderIds, over) => ({ id, projectId: git.id, text: id.includes('stalled') ? 'Seeded verdicts: a goal that needs you' : 'Seeded verdicts: a rejection with no retry coming',
    status, pmAgent: 'claude', orderIds, error: null, rawPlan: null, held: false, createdAt: iso(70000), finishedAt: null, ...over });
  fs.mkdirSync(path.join(store, 'orders'), { recursive: true });
  fs.mkdirSync(path.join(store, 'goals'), { recursive: true });
  for (const r of seeds) fs.writeFileSync(path.join(store, 'orders', `${r.id}.json`), JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(store, 'goals', `${g1}.json`), JSON.stringify(goal(g1, 'stalled', seeds.slice(0, 5).map((r) => r.id)), null, 2));
  fs.writeFileSync(path.join(store, 'goals', `${g2}.json`), JSON.stringify(goal(g2, 'failed', [o(6, 'final')], {
    error: `1 order(s) rejected with no retry coming; first: ${o(6, 'final')} (no attempts left (3 of 3)): it exited 3 and did not do the work`,
    finishedAt: iso(5000) }), null, 2));
  console.log('  seeded 6 verdict records under 2 goals in demo-git');
}

// The server's rule for its own banner: the secret only on an interactive
// terminal, never into a redirected log.
const shown = process.stdout.isTTY ? `${base}/?auth=${secret}` : `${base}/?auth=<see ${path.join(store, 'console-link')}>`;
console.log(`\n  board demo: ${shown}   (scheduler ${schedulerOn ? 'ON' : 'OFF'})`);
console.log(`  store: ${store}`);
console.log('  goals to type: anything (4-order plan) · DEMO-TOO-BIG · DEMO-GARBAGE');
console.log('  ^C to stop. Temp dirs are left for inspection under $TMPDIR/skillspace-demo-*\n');
