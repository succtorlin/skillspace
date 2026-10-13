#!/usr/bin/env node
// A throwaway SkillSpace for browser checks of the board (plan 3, Task 3).
//
//   node scripts/board-demo.mjs               scheduler OFF (review mode), port 4199
//   node scripts/board-demo.mjs --scheduler   scheduler ON
//   node scripts/board-demo.mjs --store DIR   reuse a store (restart → `interrupted`)
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
case "$2" in
  *"You are reviewing one finished work order."*)
    case "$2" in
      *"REVIEWER FEEDBACK"*) echo '{"verdict":"verified","reason":"fixed: the feedback was addressed"}' ;;
      *DEMO-REJECT*) echo '{"verdict":"rejected","reason":"edited the wrong file"}' ;;
      *DEMO-EXIT3*) echo '{"verdict":"rejected","reason":"it exited 3 and did not do the work"}' ;;
      *DEMO-VERDICT-PROSE*) echo "I looked at it and I am not sure." ;;
      *) echo '{"verdict":"verified","reason":"the acceptance holds"}' ;;
    esac
    exit 0 ;;
  *"You are planning work"*)
    case "$2" in
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

const server = spawn(process.execPath, ['server.js'], { cwd: repoRoot, env, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}`;
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

console.log(`\n  board demo: ${base}   (scheduler ${schedulerOn ? 'ON' : 'OFF'})`);
console.log(`  store: ${store}`);
console.log('  goals to type: anything (4-order plan) · DEMO-TOO-BIG · DEMO-GARBAGE');
console.log('  ^C to stop. Temp dirs are left for inspection under $TMPDIR/skillspace-demo-*\n');
