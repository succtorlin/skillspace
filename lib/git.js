'use strict';
const { execFile, execFileSync } = require('child_process');
const { baseEnv } = require('./env');

// How SkillSpace runs git ITSELF - never how an agent does.
//
// The threat: SkillSpace runs git inside trees an agent has just had write
// access to - status, add -A and commit in the worktree after every worker, PM
// and judge; worktree add/remove/prune and branch in the repository; rev-parse
// when it classifies a project. An agent that writes the repository's config,
// its hooks, a .gitattributes or the worktree's .git pointer can turn any of
// those into "run my command" - and that command would run as SkillSpace, with
// SkillSpace's full process.env, including every token the child-env allowlist
// exists to withhold from the agent.
//
// So every invocation gets:
//   - a MINIMAL environment: lib/env's ENV_BASE and nothing else. Ambient
//     GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE and friends are dropped by
//     construction rather than by a blocklist.
//   - no system or global config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=
//     /dev/null). An agent running as the user can write ~/.gitconfig as easily
//     as .git/config. Identity for the snapshot commit is supplied with -c by
//     the one caller that commits.
//   - command-line overrides, which outrank every config file, for each key
//     that makes the commands we run execute something: hooks, fsmonitor, and
//     (filtersFor) every configured filter driver. Auto gc/maintenance off so a
//     commit never forks background work in the user's repository.
//
// Known limits:
// - Filter drivers are disabled, git-lfs's included (its config normally
//   lives in the global config this ignores anyway). In an LFS repository a
//   worktree therefore checks out POINTER files, and an agent that edits an
//   LFS-tracked file has it committed to the order branch as the raw content.
// - safe.directory entries in the user's global config are not read. A repo
//   owned by another OS user is refused by git ("dubious ownership").
const SAFE_CONFIG = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
]);

const GIT_TIMEOUT_MS = 30000;

// `extra` carries the locations a caller resolved itself (GIT_DIR,
// GIT_WORK_TREE, GIT_COMMON_DIR) - the ONLY git variables that get through.
function gitEnv(extra) {
  return {
    ...baseEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...(extra || {}),
  };
}

function run(args, { cwd, env, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE_CONFIG, ...args], {
      cwd,
      encoding: 'utf8',
      timeout,
      // execFile's 1 MB default would reject a wide `status --porcelain` - a
      // codemod touching ~13-16k paths clears it - straight into the failure
      // path, so the read is capped where a real change cannot reach.
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(env),
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function runSync(args, { cwd, env, timeout = GIT_TIMEOUT_MS } = {}) {
  return execFileSync('git', [...SAFE_CONFIG, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, env: gitEnv(env),
  });
}

// -c overrides emptying every filter driver the repository's config defines,
// for the commands that can run one: checkout (smudge), and add, status and
// commit (clean - commit refreshes the index, and that alone ran a planted
// driver in testing). An empty command is "no filter" to git (verified on 2.50 for clean
// and process), and required=false stops a missing driver failing the
// command. Only CONFIGURED drivers can run, so enumerating them is complete -
// and reading config runs nothing. Driver names may contain dots, so the key
// is the last segment and everything between is the name.
async function filtersFor(opts) {
  let out = '';
  try {
    out = await run(['config', '--name-only', '--get-regexp', '^filter\\.'], opts);
  } catch (_) {
    return []; // exit 1 = no filter configured; anything else fails the real call below
  }
  const names = new Set();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^filter\.(.+)\.[^.]+$/);
    if (m) names.add(m[1]);
  }
  const flags = [];
  for (const n of names) {
    for (const kv of [`filter.${n}.clean=`, `filter.${n}.smudge=`, `filter.${n}.process=`, `filter.${n}.required=false`]) {
      flags.push('-c', kv);
    }
  }
  return flags;
}

module.exports = { SAFE_CONFIG, GIT_TIMEOUT_MS, gitEnv, run, runSync, filtersFor };
