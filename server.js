#!/usr/bin/env node
// SkillSpace · 可视化 Skill 控制台
// 零依赖：读取本地 Skill 文件夹 → 卡片展示 → 一键把命令投送给 codex / qodercli 执行并流式输出。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync, execFile } = require('child_process');
const { URL } = require('url');
// orders, goals, dispatch and plan are required here for the boot
// reconciliations, the agent count and the shutdown path only; the routes that
// use them live in routes/.
const orders = require('./lib/orders');
const goals = require('./lib/goals');
const dispatch = require('./lib/dispatch');
const plan = require('./lib/plan');
const verdict = require('./lib/verdict');
// For reap() only. It carries the pid guard this file's own inline version
// lacked: when spawn fails asynchronously the handle's pid is undefined, so
// -pid is NaN, process.kill throws, and the fallback child.kill() reaches a
// libuv handle whose pid is 0 - which signals OUR OWN process group.
const runner = require('./lib/runner');
// The poll loop that dispatches a goal's orders without a human clicking each
// one. Required here for start()/stop() only - the status route lives in
// routes/scheduler.js, and everything the loop itself needs it takes as
// arguments rather than reaching back into this file.
const scheduler = require('./lib/scheduler');
// The per-boot API secret. lib/auth.js carries the threat model; the short
// version is that the Origin/Host checks below stop a web page, and this stops
// a local process - including an agent this server spawned.
const auth = require('./lib/auth');
const makeProjectRoutes = require('./routes/projects');
const makeOrderRoutes = require('./routes/orders');
const makeGoalRoutes = require('./routes/goals');
const makeSchedulerRoutes = require('./routes/scheduler');
const makeAttemptRoutes = require('./routes/attempts');

const PORT = process.env.PORT || 4177;
// Declared here rather than beside listen(), because the Host-header guard
// needs it too and one default in two places would drift.
const HOST_BIND = process.env.HOST || '127.0.0.1';
const BIND_IS_LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST_BIND);
const PUBLIC = path.join(__dirname, 'public');
const HOME = os.homedir();
// Generated here and held ONLY in this constant: never written to disk, never
// put in process.env (so neither childEnv's allowlist nor
// SKILLSPACE_ENV_PASSTHROUGH=1 can hand it to an agent). Printed once, as the
// link in the listen() banner below.
const API_SECRET = auth.newSecret();

// Durable records live outside both the app directory and the user's repos, so
// upgrading SkillSpace never touches data and a project directory never gains
// SkillSpace files. Overridable so tests never write to the real home.
const SKILLSPACE_HOME = process.env.SKILLSPACE_HOME || path.join(os.homedir(), '.skillspace');

// 内置来源：本机 Codex / Claude Code 的 Skill 根目录，启动即自动扫描。
// 目录不存在或没有 Skill 时不隐藏，照常显示（前端渲染成空态），让用户知道扫过了。
const BUILTIN_SOURCES = [
  { id: 'codex', label: 'Codex', icon: '⌁', dir: process.env.CODEX_SKILLS_DIR || path.join(HOME, '.codex', 'skills') },
  { id: 'claude', label: 'Claude Code', icon: '✳', dir: process.env.CLAUDE_SKILLS_DIR || path.join(HOME, '.claude', 'skills') },
];
const BUILTIN_DIRS = new Set(BUILTIN_SOURCES.map((s) => s.dir));

// 默认目录：优先环境变量，其次第一个真实存在的内置来源，最后回落 ~/.claude/skills
const DEFAULT_SKILLS_DIR =
  process.env.SKILLS_DIR ||
  (BUILTIN_SOURCES.find((s) => fs.existsSync(s.dir)) || {}).dir ||
  path.join(HOME, '.claude', 'skills');
// 让子进程能找到装在 ~/.local/bin 的 qodercli 等
const CHILD_PATH = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`;

// ---------- 专家存储 ----------
// 不再接任何大模型 API：专家聚类交给你已经在用的 Codex / Claude Code，
// SkillSpace 只负责出口令、开一个回传口子、显示结果。
// Overridable for the same reason SKILLSPACE_HOME is: this path ignores it,
// so without the override running the test suite rewrites the developer's own
// experts.json. Rooted at __dirname by default, so existing installs are
// untouched.
const EXPERTS_FILE = process.env.SKILLSPACE_EXPERTS_FILE || path.join(__dirname, 'experts.json');

function loadExperts() {
  try {
    const j = JSON.parse(fs.readFileSync(EXPERTS_FILE, 'utf8'));
    return Array.isArray(j) ? j : (j.experts || []);
  } catch (_) { return []; }
}
function saveExperts(list) {
  fs.writeFileSync(EXPERTS_FILE, JSON.stringify(list, null, 2));
}
function newExpertId() {
  return 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 目录历史（本机状态，gitignore）
const STATE_FILE = path.join(__dirname, '.skillspace.state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {}
}
function recordDir(dir) {
  if (!dir) return;
  const s = loadState();
  const list = Array.isArray(s.recentDirs) ? s.recentDirs : [];
  s.recentDirs = [dir, ...list.filter((d) => d !== dir)].slice(0, 12);
  saveState(s);
}
function recentDirs() {
  const s = loadState();
  const list = Array.isArray(s.recentDirs) ? s.recentDirs : [];
  // 默认目录 + 专家里出现过的目录都并进来，保证历史齐全
  const fromExperts = loadExperts().map((e) => e.dir).filter(Boolean);
  return [...new Set([...list, ...fromExperts, DEFAULT_SKILLS_DIR])];
}
// 用户手动添加的目录 = 历史目录里剔掉两个内置来源
function customDirs() {
  return recentDirs().filter((d) => d && !BUILTIN_DIRS.has(d));
}
function forgetDir(dir) {
  const s = loadState();
  s.recentDirs = (Array.isArray(s.recentDirs) ? s.recentDirs : []).filter((d) => d !== dir);
  saveState(s);
}

// 自定义目录的显示名：取最后两段，避免一堆目录都叫 skills 分不清
function shortLabel(dir) {
  const parts = dir.split(path.sep).filter(Boolean);
  return parts.slice(-2).join('/') || dir;
}

// 扫描一个来源：目录在不在、能读出几个 Skill、挂了几个专家
function describeSource(src) {
  const exists = fs.existsSync(src.dir);
  let count = 0;
  let error = '';
  if (exists) {
    const r = readSkills(src.dir);
    if (r.error) error = r.error;
    else count = (r.skills || []).length;
  }
  const experts = loadExperts().filter((e) => (e.dir || DEFAULT_SKILLS_DIR) === src.dir).length;
  return { ...src, exists, count, experts, error };
}
// 全部来源：两个内置 + 用户自定义目录
function listSources() {
  const builtin = BUILTIN_SOURCES.map((s) => describeSource({ ...s, builtin: true }));
  const custom = customDirs().map((dir) =>
    describeSource({ id: 'custom:' + dir, label: shortLabel(dir), icon: '📁', dir, builtin: false })
  );
  return [...builtin, ...custom];
}
// macOS 原生「选择文件夹」对话框，返回绝对路径
// One picker, two callers, two different things being chosen. The prompt comes
// from this table and never from the request: it is interpolated into an
// AppleScript string literal, so caller-supplied text would be an injection
// point into osascript.
const PICK_PROMPTS = {
  skill: '选择本地 Skill 文件夹',
  project: '选择项目目录',
};

// Async, not execSync. The dialog stays open for as long as the user browses,
// and a synchronous spawn freezes the whole event loop for that entire time —
// no other request answered, and any live /api/run SSE stream stalled behind a
// Finder window. execFile with an argv array also keeps the path off a shell.
function pickFolder(kind) {
  const prompt = PICK_PROMPTS[kind] || PICK_PROMPTS.skill;
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', `POSIX path of (choose folder with prompt "${prompt}")`],
      { encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null); // 用户取消或非 macOS
        resolve(String(stdout).trim().replace(/\/$/, ''));
      }
    );
  });
}

// ---------- 删除：一律走废纸篓，不做硬删 ----------
// 直接 rm -rf 太狠了，误删就没了。移到 ~/.Trash 既从 Skill 目录里消失，又能在访达里捞回来。
function moveToTrash(target) {
  const trash = path.join(HOME, '.Trash');
  if (!fs.existsSync(trash)) {
    // 非 macOS 没有废纸篓，退回真删除
    fs.rmSync(target, { recursive: true, force: true });
    return { trashed: false, to: '' };
  }
  let dest = path.join(trash, path.basename(target));
  // 废纸篓里重名就加时间戳后缀，别覆盖别人
  if (fs.existsSync(dest)) dest = `${dest} ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(target, dest);
  } catch (e) {
    // 跨卷 rename 会 EXDEV，退回复制再删
    fs.cpSync(target, dest, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
  return { trashed: true, to: dest };
}

// 删一个 Skill 文件夹。层层设卡，确保只可能删到「某个 Skill 目录的直接子文件夹，且里面有 SKILL.md」
function deleteSkillFolder(dir, folder) {
  if (!dir || !folder) return { error: '缺少目录或 Skill 名' };
  // 不许出现路径分隔符和 ..，杜绝穿越
  if (folder.includes('/') || folder.includes('\\') || folder.includes('..')) return { error: '非法的 Skill 名' };
  const base = path.resolve(dir);
  const target = path.resolve(base, folder);
  if (path.dirname(target) !== base) return { error: '越界，拒绝删除' };
  if (target === base || target === HOME || target === '/') return { error: '越界，拒绝删除' };
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { error: '这个 Skill 文件夹已经不在了' };
  // 必须确实是个 Skill（有 SKILL.md），避免手滑删掉普通文件夹
  if (!getSkillFile(dir, folder)) return { error: '这个文件夹里没有 SKILL.md，不像是 Skill，已拒绝删除' };

  const r = moveToTrash(target);
  // 顺手把引用了这个 Skill 的专家清干净，免得留下死链接
  let touched = 0;
  const experts = loadExperts().map((e) => {
    if ((e.dir || DEFAULT_SKILLS_DIR) !== dir) return e;
    if (!(e.skills || []).includes(folder)) return e;
    touched++;
    return { ...e, skills: e.skills.filter((f) => f !== folder) };
  });
  if (touched) saveExperts(experts);
  return { ok: true, ...r, expertsTouched: touched };
}

// ---------- Skill 解析 ----------
function parseFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2];
    // YAML 块标量（description: > 或 |）或空值 → 收集后续缩进行
    if (val === '' || /^[|>][+-]?\s*$/.test(val)) {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
        block.push(lines[j].replace(/^\s+/, ''));
        j++;
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      val = block.join(' ').replace(/\s+/g, ' ').trim();
      i = j;
    } else {
      val = val.trim();
      i++;
    }
    out[key] = val;
  }
  return out;
}

// 关键词规则分类（离线、可扩展）
const CATEGORY_RULES = [
  ['标题/爆款', /标题|爆款|10万|起名|命名/],
  ['写作', /写作|文章|改写|润色|公众号|文案|口播|翻译|humaniz/i],
  ['图片/设计', /配图|封面|图片|设计|海报|logo|绘图|绘|视觉|image|design|draw|poster/i],
  ['PPT/幻灯片', /ppt|slide|幻灯|演示|deck|presentation/i],
  ['视频/音频', /视频|音频|录音|字幕|播客|video|audio|remotion|ffmpeg|tts|asr|妙记/i],
  ['产品/PM', /\bpm\b|产品|prd|原型|需求|roadmap|竞品|okr|prototype|proto/i],
  ['飞书/协作', /飞书|lark|多维表格|云文档|知识库|审批|日历|妙记/i],
  ['编程/开发', /代码|编程|coding|code|repo|调试|debug|mcp|skill.*creat|插件|extension|git/i],
  ['信息获取', /rss|抓取|爬|采集|搜索|热点|feed|scrap|news|trend|职位|job/i],
  ['数据/表格', /excel|表格|数据|xlsx|csv|财务|对账|报表|analy/i],
];
function classify(name, desc) {
  const text = `${name} ${desc}`;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return '其它';
}

// A skill folder may be a symlink (e.g. ~/.claude/skills/x -> ~/.agents/skills/x).
// Dirent.isDirectory() is false for links, so follow the link before deciding.
function isDirEntry(dir, ent) {
  if (ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(dir, ent.name)).isDirectory(); } catch (_) { return false; }
}

function readSkills(dir) {
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: `无法读取目录：${dir}（${e.code}）`, skills: [] };
  }
  for (const ent of entries) {
    if (!isDirEntry(dir, ent)) continue;
    const skillDir = path.join(dir, ent.name);
    // 兼容 SKILL.md / skill.md
    const candidate = ['SKILL.md', 'skill.md', 'Skill.md']
      .map((f) => path.join(skillDir, f))
      .find((p) => fs.existsSync(p));
    if (!candidate) continue;
    let fm = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(candidate, 'utf8'));
    } catch (_) {}
    const name = fm.name || ent.name;
    const desc = fm.description || '（无描述）';
    // 一句话简介：取描述的第一句（到第一个句号/触发词之前）
    const oneLine = desc.split(/。|\.\s|；|当用户|触发/)[0].slice(0, 60) + '';
    skills.push({
      id: ent.name,
      name,
      folder: ent.name,
      oneLine: oneLine || desc.slice(0, 60),
      description: desc,
      category: classify(name, desc),
      path: skillDir,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { skills, dir };
}

// ---------- agent 探测 ----------
function detectAgents() {
  const found = [];
  // Each entry declares how ITS binary takes a headless prompt. Verified:
  //   claude -p <prompt>          (--print / non-interactive)
  //   opencode run <message>
  //   codex exec <prompt>
  //   qodercli -p <prompt>
  for (const [id, bin, run] of [
    ['claude', 'claude', (p) => ['-p', p]],
    ['codex', 'codex', (p) => ['exec', p]],
    ['opencode', 'opencode', (p) => ['run', p]],
    ['qodercli', 'qodercli', (p) => ['-p', p]],
  ]) {
    try {
      execSync(`command -v ${bin}`, { env: { ...process.env, PATH: CHILD_PATH }, stdio: 'ignore' });
      found.push({ id, bin, buildArgs: run });
    } catch (_) {}
  }
  return found;
}
const AGENTS = detectAgents();

// Every agent currently running, so the count can be bounded and the whole set
// reaped at shutdown. The design's per-project maxConcurrent does not reach
// this route; this is the crude global equivalent until it does.
const RUNNING = new Set();
const MAX_CONCURRENT_RUNS = Number(process.env.SKILLSPACE_MAX_RUNS) || 4;

// ONE question, ONE answer, whoever is asking. /api/run and the orders route
// each used to count only their own pool, which made the real process limit
// twice the configured number. Counting only the OTHER side's pool in one
// direction closes half of that and leaves the other half open - an order
// could still be admitted while /api/run held every slot - so every gate goes
// through here. RUNNING holds this route's SSE children, which shutdown reaps
// directly; dispatch owns the orders' claims because it owns the release.
function agentsRunning() {
  // FOUR pools since plan 2d: /api/run's SSE children, dispatch's orders,
  // lib/plan's planning PMs, and lib/verdict's judging PMs. A PM is an agent -
  // it holds a slot in the ceiling and it holds the shutdown drain open until
  // its goal is written. Leaving it out of this count was how the fourth spawn
  // path would have escaped shutdown the way the third one did, and a judge is
  // the fifth: it holds a slot and holds the drain open until its verdict (or
  // its cancellation) is written.
  return RUNNING.size + dispatch.inFlightCount() + plan.inFlightCount() + verdict.inFlightCount();
}

// ONE ceiling, written once and asked in three places: /api/run's gate, the
// orders route's gate, and - the one that matters - inside dispatch.runOrder
// itself, so a caller that never asks is refused anyway. Three hand-copies of
// `count >= MAX` could disagree; one predicate cannot.
//
// This call is also what makes the wiring observable. Delete it and dispatch is
// unconfigured, atCapacity() is false everywhere, and BOTH ceiling tests in
// test/orders-api.test.js fail - rather than a silent unbounded server that
// every existing test still passes.
dispatch.setCapacity(() => agentsRunning() >= MAX_CONCURRENT_RUNS);

// The other half of the shutdown. dispatch.cancelAll() reaps the orders; these
// are /api/run's children, which nothing reaped at all - they are spawned
// detached precisely so they never see the signal sent to our group, and the
// RUN_TIMEOUT_MS that bounds them is a setTimeout inside THIS process. Killing
// the console therefore left credentialed agents running with no bound, which
// is the exact outcome the shutdown block's own comment says it exists to
// prevent. Measured: SIGTERM with an /api/run agent live, server exits 0, agent
// survives.
//
// Snapshot the set: finish() deletes from RUNNING as each child closes, and
// that can happen while we are still iterating.
function reapRunning(signal) {
  const children = [...RUNNING];
  for (const child of children) runner.reap(child, signal);
  return children.length;
}

// Matches the design's orderTimeoutMs default (spec §8a), which calls it the
// only thing standing between a stuck agent and an unbounded bill.
const RUN_TIMEOUT_MS = Number(process.env.SKILLSPACE_RUN_TIMEOUT_MS) || 900000;

// Agents need their own credentials to work at all, so the environment cannot
// simply be dropped — but process.env on a developer machine also carries AWS,
// GitHub, Stripe and npm tokens that an agent has no business holding, and a
// prompt is enough to make it print them. Base vars plus each agent's own auth
// prefixes; anything else stays behind.
//
// Set SKILLSPACE_ENV_PASSTHROUGH=1 to restore the old behaviour if an agent
// needs a variable this list does not name. If you hit that, the fix is to add
// the prefix here rather than leave the passthrough on.
// The base list is shared with SkillSpace's own git (lib/git.js), so the two
// cannot drift.
const { ENV_BASE } = require('./lib/env');
const ENV_PREFIXES = {
  claude: ['ANTHROPIC_', 'CLAUDE_'],
  codex: ['OPENAI_', 'CODEX_'],
  opencode: ['OPENCODE_', 'ANTHROPIC_', 'OPENAI_'],
  qodercli: ['QODER_'],
};

function childEnv(agent) {
  if (process.env.SKILLSPACE_ENV_PASSTHROUGH === '1') {
    return { ...process.env, PATH: CHILD_PATH };
  }
  const prefixes = (agent && ENV_PREFIXES[agent.id]) || [];
  const out = {};
  for (const k of ENV_BASE) if (process.env[k] !== undefined) out[k] = process.env[k];
  for (const k of Object.keys(process.env)) {
    if (prefixes.some((pre) => k.startsWith(pre))) out[k] = process.env[k];
  }
  out.PATH = CHILD_PATH;
  return out;
}

// An append-only record of every agent invocation. Without it a drive-by run
// leaves no evidence of what prompt executed against what directory. The
// prompt is hashed rather than stored: it can contain the contents of whatever
// file the request named, and this log is not the place to duplicate that.
const RUN_LOG = path.join(SKILLSPACE_HOME, 'runs.log');
function logRun({ bin, dir, folder, task, prompt }) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    bin,
    dir,
    folder,
    taskChars: (task || '').length,
    promptChars: (prompt || '').length,
    promptSha256: require('crypto').createHash('sha256').update(prompt || '').digest('hex'),
  });
  try {
    fs.mkdirSync(SKILLSPACE_HOME, { recursive: true });
    fs.appendFileSync(RUN_LOG, line + '\n');
  } catch (e) {
    // Never let logging stop a run, but never swallow it silently either.
    console.warn('[server] could not write run log:', e.message);
  }
}

// The only directories a Skill may be read from. `dir` arrives from a query
// string, and both /api/prompt and /api/run put whatever it names into an AI
// agent's instructions - so an unconstrained dir was a read primitive against
// the whole filesystem, not a convenience.
function isAllowedSkillDir(dir) {
  if (!dir) return true; // caller omitted it; DEFAULT_SKILLS_DIR is used
  try {
    const real = fs.realpathSync(dir);
    return recentDirs().some((d) => {
      try { return fs.realpathSync(d) === real; } catch (_) { return false; }
    });
  } catch (_) {
    return false;
  }
}

// 定位某个 Skill 的 SKILL.md 绝对路径（兼容大小写）
//
// Two guards, because the obvious one is not enough. `folder` traverses with
// ../ even when dir is omitted, so the resolved file must be proven to sit
// inside the base. And the SKILL.md basename is a constraint on the LINK, not
// on what it points at - a symlink named SKILL.md pointing at a private key
// read that key - so containment is checked on the realpath of the target.
function getSkillFile(dir, folder) {
  const base = path.resolve(dir || DEFAULT_SKILLS_DIR);
  if (!isAllowedSkillDir(dir)) return '';
  let realBase;
  try { realBase = fs.realpathSync(base); } catch (_) { return ''; }

  for (const f of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const candidate = path.join(base, folder, f);
    if (!fs.existsSync(candidate)) continue;
    let real;
    try { real = fs.realpathSync(candidate); } catch (_) { continue; }
    if (real !== realBase && !real.startsWith(realBase + path.sep)) continue;
    return candidate;
  }
  return '';
}

// 读取某个 Skill 的 SKILL.md 正文（去掉 frontmatter），用于注入到命令
function getSkillBody(dir, folder) {
  const p = getSkillFile(dir, folder);
  if (!p) return '';
  const md = fs.readFileSync(p, 'utf8');
  return md.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

// 构造「粘贴到 Codex 的口令」——不依赖具体 agent 二进制。
//   mode=path（默认）：给 Codex 指路——调用哪个 Skill + 补充说明 + SKILL.md 调用地址，让 Codex 自己读。短且稳。
//   mode=inject：把 SKILL.md 正文整篇塞进去（换机器 / Codex 读不到该路径时用）。
function buildPrompt(name, task, dir, folder, mode) {
  const note = task || '（无，按该 Skill 的默认流程执行）';
  if (mode === 'inject') {
    const body = folder ? getSkillBody(dir || DEFAULT_SKILLS_DIR, folder) : '';
    if (body) {
      return (
        `请严格按照下面这份《Skill 说明书》的方法来完成任务，只输出最终结果，不要复述说明书。\n\n` +
        `===== Skill 说明书：${name} =====\n${body}\n\n` +
        `===== 你的任务 =====\n${note}`
      );
    }
  }
  // 默认：路径式口令
  const file = folder ? getSkillFile(dir, folder) : '';
  return (
    `请调用 Skill：${name}\n` +
    `补充说明：${note}\n` +
    `Skill 调用地址：${file || '（未找到 SKILL.md）'}`
  );
}

// 把专家里的 folder 列表解析成 Skill 元信息
function resolveSkills(dir, folders) {
  const { skills } = readSkills(dir);
  const byFolder = new Map((skills || []).map((s) => [s.folder, s]));
  return (folders || []).map((f) => byFolder.get(f)).filter(Boolean);
}

// 构造「专家口令」：让 Codex 在整段对话里按关键词自动挑用这组 Skill，并在每步后提示下一步可用的 Skill
function buildExpertPrompt(expert, dir) {
  const useDir = expert.dir || dir || DEFAULT_SKILLS_DIR;
  const items = resolveSkills(useDir, expert.skills);
  const lines = items
    .map((s) => `- ${s.name}：${s.oneLine} → 调用地址：${getSkillFile(useDir, s.folder)}`)
    .join('\n');
  return (
    `你现在担任「${expert.name}」${expert.emoji ? '（' + expert.emoji + '）' : ''}。${expert.description || ''}\n\n` +
    `以下是本次对话中你可以随时调用的一组 Skill。工作方式：\n` +
    `1. 根据我发来的内容或关键词，自动判断该用哪个 Skill；\n` +
    `2. 调用时按该 Skill「调用地址」里的 SKILL.md 说明来执行；\n` +
    `3. 每完成一步，主动告诉我：接下来还可以用哪些 Skill 做下一步操作。\n\n` +
    `可用 Skill（共 ${items.length} 个）：\n${lines}`
  );
}

// ---------- 分类任务：出口令给 Codex / Claude Code 跑，再由它回传结果 ----------
// 任务只活在内存里，进程重启就没了，本来也是一次性的。
const JOBS = new Map();
function newToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function createJob(dir, skills) {
  const token = newToken();
  const job = { token, dir, count: skills.length, status: 'waiting', experts: [], error: '', createdAt: Date.now() };
  JOBS.set(token, job);
  // 只留最近 20 个任务，免得内存里越积越多
  if (JOBS.size > 20) {
    const oldest = [...JOBS.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) JOBS.delete(oldest.token);
  }
  return job;
}

// 给 Codex / Claude Code 的口令：Skill 清单 + 聚类要求 + 回传命令
function buildClassifyPrompt(job, skills) {
  const list = skills.map((s) => `${s.folder} | ${s.name} | ${s.oneLine}`).join('\n');
  const url = `http://localhost:${PORT}/api/experts/import?token=${job.token}`;
  return (
    `帮我把下面这批本地 AI Skill 按用途聚类，打包成若干「专家」。\n\n` +
    `每个专家是一组用途高度相关的 Skill 集合，名字要像职业或角色，例如「内容创作专家」「配图设计专家」「数据分析专家」。\n` +
    `请聚成 6-12 个专家，尽量覆盖多数 Skill，一个 Skill 归到一个最合适的专家即可。\n\n` +
    `Skill 清单（共 ${skills.length} 个，格式：folder | 名称 | 简介）：\n${list}\n\n` +
    `分好之后，执行下面这条命令把结果回传给 SkillSpace（本机服务，直接跑就行）：\n\n` +
    `curl -X POST '${url}' \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -d '{"experts":[{"name":"内容创作专家","description":"一句话说明这个专家能干什么","skills":["folder-a","folder-b"]}]}'\n\n` +
    `把 -d 后面换成你实际的聚类结果。skills 数组里放 Skill 的 folder（清单第一列，原样照抄，不要改名）。\n` +
    `回传成功会返回 {"ok":true,...}。跑完告诉我建了几个专家就行。`
  );
}

// 校验并落库 Codex / Claude Code 回传的聚类结果
function importExperts(job, payload) {
  const arr = Array.isArray(payload) ? payload : (payload && payload.experts) || [];
  if (!Array.isArray(arr) || !arr.length) return { error: 'experts 是空的或者格式不对' };
  const { skills } = readSkills(job.dir);
  const valid = new Set((skills || []).map((s) => s.folder));
  const cleaned = arr
    .map((e) => ({
      name: String((e && e.name) || '未命名专家').slice(0, 30),
      description: String((e && e.description) || '').slice(0, 200),
      // 只认真实存在的 folder，模型编出来的一律丢掉
      skills: (Array.isArray(e && e.skills) ? e.skills : []).filter((f) => valid.has(f)),
    }))
    .filter((e) => e.skills.length);
  if (!cleaned.length) return { error: 'skills 里没有一个能对上真实的 Skill folder，请照抄清单第一列' };
  const created = cleaned.map((e) => ({
    id: newExpertId(),
    ...e,
    dir: job.dir,
    source: 'auto',
    createdAt: new Date().toISOString(),
  }));
  saveExperts(loadExperts().concat(created));
  const covered = new Set(cleaned.flatMap((e) => e.skills)).size;
  return { ok: true, experts: created, covered, total: valid.size };
}

function buildCommand(agentId, name, task, dir, folder) {
  // Two stacked fallbacks used to live here and in the route, so a caller who
  // named a specific agent - deliberately routing risky work to a sandboxed or
  // cheaper one - silently got AGENTS[0] on a typo or a stale client value, and
  // could only find out by reading the start line. An id that was supplied and
  // is not recognised is now an error; an absent id still defaults.
  const agent = agentId ? AGENTS.find((a) => a.id === agentId) : AGENTS[0];
  if (!agent) return null;
  const body = folder ? getSkillBody(dir || DEFAULT_SKILLS_DIR, folder) : '';
  let prompt;
  if (body) {
    // 注入式：把 Skill 说明书正文塞进去，任何 agent 都能照着做，不依赖它是否注册了该 Skill
    prompt =
      `请严格按照下面这份《Skill 说明书》的方法来完成任务，只输出最终结果，不要复述说明书。\n\n` +
      `===== Skill 说明书：${name} =====\n${body}\n\n` +
      `===== 你的任务 =====\n${task || '按该 Skill 的默认流程执行。'}`;
  } else {
    prompt = `请使用「${name}」这个 Skill 来完成以下任务：\n${task || '（无补充说明，按默认流程执行）'}`;
  }
  // 预览命令做精简展示，不把整篇说明书铺出来。
  // 子命令/开关直接取自真实 args，预览和实际执行不会各说各话。
  const args = agent.buildArgs(prompt);
  const flag = args.length > 1 ? args[0] : '';
  const display = body
    ? `${agent.bin} ${flag} "〈注入「${name}」Skill 说明书〉+ 任务：${task || '默认流程'}"`
    : `${agent.bin} ${flag} "请使用「${name}」这个 Skill：${task || '默认流程'}"`;
  return { bin: agent.bin, agent, args, prompt, display, injected: !!body };
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
// 1 MiB. A project record is a few hundred bytes; anything approaching this is
// a mistake or an attack. The cap lives here rather than per-route because a
// body this size is already a problem before anyone decides what to do with it
// - and since Task 3 these bytes can become durable state that every later
// list request re-reads.
const MAX_BODY = 1024 * 1024;

// A Symbol key, not a string like "__oversize": a string sentinel is forgeable.
// {"__oversize":true} is 22 bytes of perfectly legal JSON, and a caller sending
// it under the limit got a spurious 413 (verified). A Symbol cannot arrive from
// JSON.parse at all.
//
// The Symbol only helps because readBody GUARANTEES a plain non-null object
// below. It did not always: reading body[OVERSIZE] off a null body threw and
// killed the process, so the sentinel chosen to prevent a crash became one.
const OVERSIZE = Symbol('oversize');

// Distinct from an empty body: resolving {} conflated "the client sent
// nothing" with "the client gave up", and /api/experts writes on empty input,
// so navigating away mid-request persisted a defaulted 未命名专家.
const ABORTED = Symbol('aborted');

function readBody(req) {
  return new Promise((resolve) => {
    // Buffers, concatenated and decoded ONCE at the end. `b += chunk` coerced
    // each chunk independently, so a multibyte character split across two TCP
    // segments decoded to replacement characters on both sides and was written
    // to disk that way - in a product whose UI is entirely Chinese.
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      // Bytes, not UTF-16 units. One CJK character is 3 bytes but 1 unit, so a
      // .length cap admitted roughly 3x its stated size.
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    // A client that hangs up mid-body never emits 'end', so without these the
    // promise never settles and the handler is wedged forever. resolve() is
    // idempotent, so a late 'end' after an abort is harmless.
    req.on('aborted', () => resolve({ [ABORTED]: true }));
    req.on('error', () => resolve({ [ABORTED]: true }));
    req.on('end', () => {
      if (over) return resolve({ [OVERSIZE]: true });
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { return resolve({}); }
      // JSON.parse returns null, numbers and strings too - and "null" is
      // truthy, so the old ternary handed null straight to the callers, where
      // body[OVERSIZE] threw and took the process with it. Every caller treats
      // the body as an object; guarantee one here rather than asking three
      // call sites to remember.
      //
      // Arrays pass through: importExperts explicitly accepts a top-level
      // array, which is a very plausible shape for the agent classification
      // results POSTed to that callback. Coercing them to {} made that branch
      // dead code. They are safe at the other two call sites for the same
      // reason a plain {} is - reading .name off an array yields undefined and
      // a defaulted record, never a throw.
      if (!parsed || typeof parsed !== 'object') return resolve({});
      return resolve(parsed);
    });
  });
}
// Taken from routes/common.js rather than defined again here: routes/goals.js
// needs the same predicate to screen the ids inside a goal's orderIds, and
// three copies of "what an id may look like" is how one of them ends up
// accepting a separator. The reason it exists is recorded there.
// resolveAgent comes from here for the same reason: agentFor below is a fourth
// caller of "which agent did this ask for", and the three that already exist
// agree only because they share this one implementation.
const { isPlainId, resolveAgent } = require('./routes/common');

// Decode BEFORE validating, or "a%2Fb" would pass the plain-id test while
// still carrying a separator into the store. A malformed escape like %ZZ is
// not a decodable id at all, so it is rejected the same way a bad one is.
// Answers the 400 itself and returns null, so a caller's next line is a guard
// rather than a fourth copy of this.
function plainIdFrom(res, raw, label) {
  let id;
  try {
    id = decodeURIComponent(raw);
  } catch (_) {
    sendJson(res, 400, { error: `invalid ${label} id` });
    return null;
  }
  if (!isPlainId(id)) {
    sendJson(res, 400, { error: `invalid ${label} id` });
    return null;
  }
  return id;
}

// The bind stops the network reaching us; this stops a web page doing it. A
// cross-origin POST with Content-Type: text/plain is a CORS "simple request" -
// no preflight - so any site the user visits could write to the registry. And
// /api/run spawns an agent from a GET, which <img src> triggers with no Origin
// header at all, so Sec-Fetch-Site is the header that actually covers it.
// Absent headers mean a non-browser client (curl, the test suite): allowed by
// THIS check, which is only about web pages. A local process is what the
// per-boot API secret (lib/auth.js) is for; it is checked right after this.
//
// The two checks are NOT redundant - they cover disjoint request classes, and
// removing either silently uncovers a class the other never saw. Origin is
// absent on cross-site GET subresources; Sec-Fetch-* is absent on Safari
// < 16.4. A browser in that gap sends neither and gets through, because its
// Host really is 127.0.0.1, so hostAllowed cannot help. Nothing this file owns
// rests on the weak side - GET is read-only and unreadable cross-origin
// without CORS headers, a cross-site form POST always carries Origin, and
// DELETE is preflighted - so the residual landed on /api/run, which now also
// requires the API secret: a cross-site <img src> cannot know it.
function isCrossOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return !local || u.port !== String(PORT);
  } catch (_) { return true; }
}

// Host validation defeats DNS rebinding, which only matters while we are
// loopback-only. Binding a non-loopback HOST is a deliberate opt-out of that
// protection: enforcing the loopback allowlist there would bind every
// interface and then 403 every request that used it, which is not a security
// posture, just a confusing one. isCrossOrigin stays unconditional - that is
// CSRF defence and applies whatever we are bound to.
function hostAllowed(req) {
  const h = req.headers.host;
  // Refused whatever we are bound to. Every browser and curl sends Host; a
  // request without one is a hand-rolled client, and "absent means allowed"
  // was the half of this check a local process could walk straight through.
  if (!h) return false;
  if (!BIND_IS_LOOPBACK) return true;
  const name = h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

// isCrossOrigin allows Sec-Fetch-Site: none, which is correct for the console
// itself — a browser sends `none` for a navigation with no initiator. But that
// is also what it sends for a link clicked in Slack, Mail, Notes, a PDF or an
// IDE markdown preview, all of which hand the URL over as a fresh navigation.
// For a route that merely renders a page that is fine; for one that spawns a
// credentialed AI agent, or deletes a record, one click is too low a bar.
//
// The console's own calls are unaffected: fetch and EventSource send
// Sec-Fetch-Mode: cors with Dest: empty, never navigate/document. The cost is
// that pasting such a URL into the address bar to debug now 403s, which is the
// point.
function isTopLevelNavigation(req) {
  return (
    req.headers['sec-fetch-mode'] === 'navigate' ||
    req.headers['sec-fetch-dest'] === 'document'
  );
}

// One shape for all three refusals. The cancel route's copy had drifted to a
// bare "forbidden", dropping the half of the message that tells whoever hits
// it what actually happened and why.
function denyNavigation(res, what) {
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`forbidden: ${what} is not a navigable URL`);
}

// The console's own files. A Set, not a chain of ===, so adding one is one
// edit; anything not named here is not served, whatever is in public/.
const CONSOLE_ASSETS = new Set([
  '/auth.js', '/app.js', '/icons.js', '/pure.js', '/style.css',
  '/board.css', '/board.js', '/order-drawer.js', '/goal-panel.js',
]);

function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) {
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(full);
  const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[ext] || 'text/plain';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

// The console page, for the holder of the cookie only, with the secret in a
// <meta> for public/auth.js to send on every /api/* fetch. no-store: a cached
// copy of this page is a cached copy of the secret.
function serveConsole(res) {
  let html;
  try { html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (_) {
    res.writeHead(404); return res.end('not found');
  }
  html = html.replace('<head>', `<head>\n<meta name="skillspace-auth" content="${API_SECRET}">`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// What GET / answers to anyone without the cookie - curl and a prompt-injected
// agent included. It names where the key is and carries nothing else.
const LOCK_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>SkillSpace · 已上锁</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px;color:#ddd;background:#141414}
code{background:#222;padding:2px 6px;border-radius:4px}</style></head><body>
<h1>SkillSpace 已上锁</h1>
<p>这个控制台能派出 AI agent，所以只对拿着本次启动钥匙的人开放。</p>
<p>回到启动 SkillSpace 的终端，打开里面打印的那条链接（形如 <code>http://localhost:PORT/?auth=…</code>）。每次重启钥匙都会换新。</p>
</body></html>`;

function serveLock(res) {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(LOCK_PAGE);
}

// The one /api/* path that is NOT gated by the secret: the classification
// callback an agent curls (buildClassifyPrompt). That agent is deliberately
// never given the API secret; the per-job token in its URL is its credential,
// and the route refuses an unknown one.
function authExempt(req, p) {
  return p === '/api/experts/import' && req.method === 'POST';
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  // Before routing: every route, including the SSE agent spawn.
  if (isCrossOrigin(req) || !hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  // After the cross-origin and Host checks, which still apply to everything:
  // those stop a web page, this stops a local process. /api/run is inside the
  // prefix, so a header-less GET cannot spawn an agent either.
  if (p.startsWith('/api/') && !authExempt(req, p) && !auth.apiAuthorized(req, u, API_SECRET)) {
    return sendJson(res, 401, {
      error: 'unauthorized: open the link SkillSpace printed in its terminal (the key changes on every restart)',
    });
  }

  // Every route below runs inside this. A throw from a lib call used to take
  // the whole process down - DELETE called projects.remove() bare, so an
  // unwritable store (EACCES) or a projects.json that parsed but wasn't an
  // array killed the dispatcher, and any live SSE stream with it, from one
  // ordinary click. The POST route already reasoned about that error; DELETE
  // did not, and goals/orders routes land next. Making it the handler's rule
  // rather than each route's responsibility is what stops the asymmetry
  // replicating.
  try {
    return await route(req, res, u, p);
  } catch (e) {
    console.error('[server] unhandled error in %s %s:', req.method, p, e);
    // Headers may already be sent by a streaming route; writing again would
    // throw a second time, inside the catch that exists to prevent exactly
    // that. Destroying is the only honest close at that point.
    if (res.headersSent) return res.destroy();
    return sendJson(res, 500, { error: 'internal error' });
  }
});

// Constants bind once; only the four per-request values are rebuilt. A route
// that needs a new capability now names it in one signature rather than
// reaching into a shared bag that every module can see, and a key it forgot to
// wire is a boot-time fault rather than a TypeError on the first request that
// happens to need it.
//
// Constructed here rather than beside the requires at the top: SKILLSPACE_HOME,
// AGENTS, MAX_CONCURRENT_RUNS, OVERSIZE and ABORTED are all `const`, so reading
// them any earlier is a temporal-dead-zone throw at boot.
const routeDeps = {
  root: SKILLSPACE_HOME,
  sendJson, readBody, OVERSIZE, ABORTED,
  plainIdFrom, isTopLevelNavigation, denyNavigation,
  AGENTS, maxConcurrentRuns: MAX_CONCURRENT_RUNS,
  // The credential allowlist and CHILD_PATH. /api/run has always used it;
  // the orders path could not reach it, so it spawned with process.env.
  childEnv,
};
const projectRoutes = makeProjectRoutes(routeDeps);
const orderRoutes = makeOrderRoutes(routeDeps);
const goalRoutes = makeGoalRoutes(routeDeps);
// Takes the same deps object as the other three and uses one key of it. See
// routes/scheduler.js for why the list is that short.
const schedulerRoutes = makeSchedulerRoutes(routeDeps);
// The two doors a human uses after a verdict. None of its paths overlaps a
// sibling's: routes/orders.js matches /api/orders/:id exactly, /:id/cancel and
// /:id/dispatch.
const attemptRoutes = makeAttemptRoutes(routeDeps);

async function route(req, res, u, p) {
  if (p === '/') {
    // The printed link: trade the secret for a cookie and get it out of the
    // address bar (and the history) at once.
    if (u.searchParams.has(auth.QUERY)) {
      if (!auth.matches(u.searchParams.get(auth.QUERY), API_SECRET)) return serveLock(res);
      res.writeHead(302, {
        'Set-Cookie': auth.setCookieHeader(PORT, API_SECRET),
        Location: '/',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    if (!auth.cookieAuthorized(req, PORT, API_SECRET)) return serveLock(res);
    return serveConsole(res);
  }
  if (CONSOLE_ASSETS.has(p)) return serveStatic(res, p.slice(1));
  // Marketing surface. Deliberately a separate direction from the console:
  // the app is an instrument, this page sells the idea of it.
  if (p === '/landing' || p === '/landing.html') return serveStatic(res, 'landing.html');
  if (p === '/landing.css') return serveStatic(res, 'landing.css');
  if (p === '/landing.js') return serveStatic(res, 'landing.js');

  // Each module answers or declines; none of the five overlaps any path below
  // or each other, so the order they are tried in and their position here are
  // free. Their constants
  // were bound once at construction (see routeDeps); only the four per-request
  // values are rebuilt here.
  const rq = { req, res, u, p };
  if (await projectRoutes(rq)) return;
  if (await orderRoutes(rq)) return;
  if (await goalRoutes(rq)) return;
  if (await schedulerRoutes(rq)) return;
  if (await attemptRoutes(rq)) return;

  if (p === '/api/config') {
    return sendJson(res, 200, {
      defaultDir: DEFAULT_SKILLS_DIR,
      agents: AGENTS.map((a) => a.id),
    });
  }

  // ---------- 专家 ----------
  if (p === '/api/experts' && req.method === 'GET') {
    const dir = u.searchParams.get('dir');
    let experts = loadExperts();
    // 传了 dir 就只返回该目录下创建的专家（切换目录时恢复对应专家）
    if (dir) experts = experts.filter((e) => (e.dir || DEFAULT_SKILLS_DIR) === dir);
    return sendJson(res, 200, { experts });
  }
  if (p === '/api/experts' && req.method === 'POST') {
    const body = await readBody(req);
    if (body[ABORTED]) return; // else a hung-up upload leaves a defaulted expert
    // Before body.name is read: without this an oversized body fell through to
    // the defaults below and silently persisted a junk expert.
    if (body[OVERSIZE]) return sendJson(res, 413, { error: 'request body too large' });
    const experts = loadExperts();
    const expert = {
      id: newExpertId(),
      name: String(body.name || '未命名专家').slice(0, 30),
      emoji: String(body.emoji || '🧩').slice(0, 4),
      description: String(body.description || '').slice(0, 200),
      skills: Array.isArray(body.skills) ? body.skills : [],
      dir: body.dir || DEFAULT_SKILLS_DIR,
      source: body.source || 'manual',
      createdAt: new Date().toISOString(),
    };
    experts.push(expert);
    saveExperts(experts);
    return sendJson(res, 200, { expert });
  }
  if (p === '/api/experts' && req.method === 'DELETE') {
    const id = u.searchParams.get('id');
    saveExperts(loadExperts().filter((e) => e.id !== id));
    return sendJson(res, 200, { ok: true });
  }
  // 开一个分类任务，返回给 Codex / Claude Code 用的口令
  if (p === '/api/experts/job' && req.method === 'POST') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const { skills, error } = readSkills(dir);
    if (error) return sendJson(res, 400, { error });
    if (!skills || !skills.length) return sendJson(res, 400, { error: '这个来源里没有 Skill，没法分类' });
    const job = createJob(dir, skills);
    return sendJson(res, 200, { token: job.token, count: skills.length, prompt: buildClassifyPrompt(job, skills) });
  }
  // 轮询任务状态：前端拿这个显示「等待中 / 已完成」
  if (p === '/api/experts/job' && req.method === 'GET') {
    const job = JOBS.get(u.searchParams.get('token') || '');
    if (!job) return sendJson(res, 404, { error: '任务不存在或已过期' });
    return sendJson(res, 200, {
      status: job.status, error: job.error,
      experts: job.experts, covered: job.covered, total: job.total,
    });
  }
  // 回传口子：Codex / Claude Code 把聚类结果 POST 回来
  if (p === '/api/experts/import' && req.method === 'POST') {
    const job = JOBS.get(u.searchParams.get('token') || '');
    if (!job) return sendJson(res, 404, { error: '任务不存在或已过期，请回 SkillSpace 重新生成口令' });
    const body = await readBody(req);
    if (body[ABORTED]) return; // don't fail the job over a dropped connection
    // Without this an oversized import reports "experts is empty or malformed"
    // and flips the job to error on false grounds.
    if (body[OVERSIZE]) return sendJson(res, 413, { error: 'request body too large' });
    const r = importExperts(job, body);
    if (r.error) {
      job.status = 'error';
      job.error = r.error;
      return sendJson(res, 400, { error: r.error });
    }
    job.status = 'done';
    job.experts = r.experts;
    job.covered = r.covered;
    job.total = r.total;
    return sendJson(res, 200, { ok: true, created: r.experts.length, covered: r.covered, total: r.total });
  }
  // 专家口令
  if (p === '/api/expert-prompt') {
    const id = u.searchParams.get('id');
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const expert = loadExperts().find((e) => e.id === id);
    if (!expert) return sendJson(res, 404, { error: '专家不存在' });
    const prompt = buildExpertPrompt(expert, dir);
    return sendJson(res, 200, { prompt, chars: prompt.length });
  }

  if (p === '/api/skills' && req.method === 'DELETE') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const folder = u.searchParams.get('folder') || '';
    const r = deleteSkillFolder(dir, folder);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (p === '/api/skills') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const result = readSkills(dir);
    if (!result.error) recordDir(dir); // 成功读取才记入历史
    return sendJson(res, 200, result);
  }

  // 最近使用过的 Skill 目录（历史）
  if (p === '/api/dirs') {
    return sendJson(res, 200, { dirs: recentDirs(), default: DEFAULT_SKILLS_DIR });
  }

  // 来源列表：自动扫描本机 Codex / Claude Code 的 Skill 目录 + 用户自定义目录
  if (p === '/api/sources' && req.method === 'GET') {
    return sendJson(res, 200, { sources: listSources(), default: DEFAULT_SKILLS_DIR });
  }
  // 移除一个自定义目录（内置来源不允许删）
  if (p === '/api/sources' && req.method === 'DELETE') {
    const dir = u.searchParams.get('dir') || '';
    if (BUILTIN_DIRS.has(dir)) return sendJson(res, 400, { error: '内置来源不能移除' });
    forgetDir(dir);
    return sendJson(res, 200, { ok: true, sources: listSources() });
  }

  // 弹出 macOS 原生文件夹选择框，返回绝对路径
  if (p === '/api/pick-dir') {
    // 'for' selects a prompt from a fixed table; it is never interpolated.
    const dir = await pickFolder(u.searchParams.get('for'));
    if (!dir) return sendJson(res, 200, { cancelled: true });
    return sendJson(res, 200, { dir });
  }

  // 返回「粘贴到 Codex 的口令」文本（供前端预览 + 复制）
  if (p === '/api/prompt') {
    const name = u.searchParams.get('skill') || '';
    const task = u.searchParams.get('task') || '';
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const folder = u.searchParams.get('folder') || '';
    const mode = u.searchParams.get('mode') || 'path';
    const prompt = buildPrompt(name, task, dir, folder, mode);
    return sendJson(res, 200, { prompt, mode, chars: prompt.length });
  }

  // SSE 流式运行
  if (p === '/api/run') {
    // A GET that spawns a credentialed agent is one clicked link away from
    // running an attacker's prompt: Slack, Mail, Notes and IDE previews all
    // hand a URL to the browser as a top-level navigation, which arrives as
    // Sec-Fetch-Site: none and passes isCrossOrigin. EventSource does not.
    if (isTopLevelNavigation(req)) return denyNavigation(res, '/api/run');
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('method not allowed');
    }
    // Bounded because each spawn is a real billed invocation and nothing else
    // limits them. The design's per-project maxConcurrent (2 git / 1 dir) does
    // not reach this route, which predates it.
    // The one ceiling, asked through dispatch so this route, the orders route
    // and runOrder itself cannot drift apart.
    if (dispatch.atCapacity()) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`too many agents running (${MAX_CONCURRENT_RUNS})`);
    }

    const rawAgent = u.searchParams.get('agent');
    const agentId = rawAgent || (AGENTS[0] && AGENTS[0].id);
    const name = u.searchParams.get('skill') || '';
    const task = u.searchParams.get('task') || '';
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const folder = u.searchParams.get('folder') || '';
    const cmd = buildCommand(agentId, name, task, dir, folder);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!cmd) {
      // Distinguish "you named an agent we do not have" from "none installed".
      // Falling back silently ran a different tool than the caller asked for.
      const msg = rawAgent && !AGENTS.some((a) => a.id === rawAgent)
        ? `未知的 agent：${rawAgent}（可用：${AGENTS.map((a) => a.id).join(', ') || '无'}）`
        : '没有检测到可用的 agent（claude / codex / opencode / qodercli），请先安装其一。';
      send('error', msg);
      return res.end();
    }
    // The full prompt, not just the elided preview: when a Skill body is
    // injected, the preview shows 〈注入…〉 and the actual instructions - which
    // may be file contents - are invisible at the one moment a human watches.
    send('start', { command: cmd.display, prompt: cmd.prompt, injected: cmd.injected });
    logRun({ bin: cmd.bin, dir, folder, task, prompt: cmd.prompt });

    // detached so the child leads its own process group: agent CLIs spawn tool
    // subprocesses, and killing only the direct pid left those orphaned to
    // PID 1 - still writing files, still billing, invisible to SkillSpace.
    // cwd is a scratch directory: without it the agent inherited the server's,
    // i.e. the SkillSpace install tree, where "edit server.js" is a
    // persistence primitive. Spec §5: never the install directory.
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-run-'));
    const child = spawn(cmd.bin, cmd.args, {
      cwd: runCwd,
      env: childEnv(cmd.agent),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    RUNNING.add(child);

    let settled = false;
    // Negative pid signals the whole group, so the agent's tool subprocesses go
    // with it. runner.reap owns that plus the pid<=0 guard; the copy that used
    // to live here had the group kill but not the guard.
    const reap = (signal) => runner.reap(child, signal);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      RUNNING.delete(child);
      fs.rm(runCwd, { recursive: true, force: true }, () => {});
    };
    // The only thing between a stuck agent and an unbounded bill (spec §8a).
    const timer = setTimeout(() => {
      send('error', `agent 超时（${RUN_TIMEOUT_MS / 1000}s），已终止`);
      reap('SIGTERM');
      setTimeout(() => reap('SIGKILL'), 5000).unref();
    }, RUN_TIMEOUT_MS);
    timer.unref();

    child.stdout.on('data', (d) => send('chunk', d.toString()));
    child.stderr.on('data', (d) => send('chunk', d.toString()));
    child.on('close', (code) => { finish(); send('done', { code }); res.end(); });
    child.on('error', (e) => { finish(); send('error', String(e.message || e)); res.end(); });
    req.on('close', () => {
      if (settled) return;
      reap('SIGTERM');
      setTimeout(() => reap('SIGKILL'), 5000).unref();
      finish();
    });
    return;
  }

  res.writeHead(404); res.end('not found');
}

// Loopback only. This process dispatches AI agents with write access to any
// registered directory and has no authentication whatsoever - the design
// assumes "local, single user", and listen(PORT) with no host quietly broke
// that assumption by binding every interface. Overridable for anyone who
// deliberately wants otherwise, but never by default.
//
// IPv4 specifically. `localhost` resolves to ::1 first on many systems, so a
// client that does NOT fall back to 127.0.0.1 will be refused - browsers, curl
// and undici all do fall back, which is the entire client set for this tool.
// A second listener on ::1 would cover the rest at the cost of a second bind
// to fail on.
//
// HOST=::1 switches to IPv6 loopback (verified: localhost and [::1] answer,
// 127.0.0.1 is then refused). There is NO single value covering both loopbacks
// - in particular HOST=:: is not it: that binds *, every interface, which is
// the exact exposure this default exists to prevent. Covering both needs a
// second listen() call, deliberately not done.
//
// Setting any non-loopback HOST also switches OFF the Host-header allowlist
// (see BIND_IS_LOOPBACK): it is an opt-out of DNS-rebinding protection, which
// is meaningless once the socket is reachable from the network anyway. The
// Origin/Sec-Fetch-Site check still applies.
//
// (The reconcile and shutdown blocks below sit between that comment and the
// server.listen() call it explains. Kept adjacent to listen rather than moved,
// because both must run before the socket is accepting.)

// Any order still marked running lost its child process when the previous
// server died. It is never assumed to have succeeded.
try {
  const n = orders.reconcile(SKILLSPACE_HOME);
  if (n) console.log(`  reconciled ${n} interrupted order(s)`);
} catch (e) {
  console.warn('[server] could not reconcile orders:', e.message);
}

// And any goal still marked planning lost the PM that was decomposing it, while
// any goal still marked running lost everything that could observe the agents
// its claim rested on. The two are corrected differently: `planning` is FAILED,
// `running` is DEMOTED to `planned` - its orders are reconciled individually
// above, and nothing here can say whether the goal as a whole finished, so the
// goal keeps its plan rather than being judged.
//
// Only the failures are counted, so this can legitimately print nothing on a
// boot that corrected a great many goals. lib/goals says why.
try {
  const n = goals.reconcile(SKILLSPACE_HOME);
  if (n) console.log(`  reconciled ${n} interrupted goal(s)`);
} catch (e) {
  console.warn('[server] could not reconcile goals:', e.message);
}

// A judgement still `judging` lost its judge with the previous process. It is
// recorded as an error - not reset for the loop to re-run - and a human
// retries it. BEFORE scheduler.start(): the first tick reads an unclaimed
// `judging` as "awaiting a verdict", and its goal would stall at `planned` with
// nothing ever going to finish it. Pinned by 'a judgement interrupted by a
// restart is recorded, not resumed'.
try {
  const n = orders.reconcileVerdicts(SKILLSPACE_HOME);
  if (n) console.log(`  reconciled ${n} interrupted verdict(s)`);
} catch (e) {
  console.warn('[server] could not reconcile verdicts:', e.message);
}

// AFTER BOTH RECONCILES ABOVE. start() runs its first tick SYNCHRONOUSLY, and
// that tick is the startup sweep - so it must not run until orders.reconcile()
// has turned a killed process's `running` orders into `interrupted`, or the
// sweep reads them as neither settled nor in flight and stalls their goal at
// `planned`. The full reasoning, including which half of it is NOT true, is the
// ordering entry in lib/scheduler.js's Known limits: it belongs with the module
// that imposes the requirement rather than in a second copy here that can drift
// from it. Pinned by 'the scheduler starts only after the boot reconciles'.
//
// The two callbacks are REQUIRED by start() and deliberately not defaulted,
// and both defaults would be this file's to supply:
//
//   childEnv  the credential allowlist. Its only plausible default is
//             process.env, which is every AWS, GitHub and npm token on the
//             machine handed to an agent that needs its own provider key -
//             the exact leak the allowlist exists to prevent. lib/dispatch
//             refuses per order and lib/plan per goal; this refuses at boot.
//   agentFor  which agent runs an order. Picking one would run a human's
//             prompt through a tool they did not choose.
//
// A third, judgeFor, is optional to lib/scheduler - its absence turns verdicts
// off visibly rather than leaking anything - and this file always passes it.
//
// A throw from start() is therefore NOT caught the way the two reconciles above
// are. Both are configuration faults in this file, and a console that booted
// happily with no scheduler would look identical to a working one right up
// until nothing ever ran.
//
// SKILLSPACE_SCHEDULER=0 LEAVES IT UNSTARTED, and this is a real product mode
// rather than a test hook: plan 2b shipped approving one planned order at a
// time through POST /api/orders/:id/dispatch, and that door is still open - the
// scheduler is what makes it optional, not what removes it. A user who wants to
// read each order before it runs turns the loop off and keeps the door.
//
// Compared as an EXACT STRING, matching SKILLSPACE_ENV_PASSTHROUGH above rather
// than inventing a second truthiness convention in one file. Any other value -
// including 'false' or 'off' - leaves the scheduler ON, which is the direction
// that fails toward the documented default rather than silently disabling the
// feature; GET /api/scheduler reports `running`, so which way it actually went
// is observable rather than guessed.
const schedulerIntervalMs = Number(process.env.SKILLSPACE_SCHEDULER_INTERVAL_MS) || 0;
if (process.env.SKILLSPACE_SCHEDULER === '0') {
  console.log('  scheduler: off (SKILLSPACE_SCHEDULER=0) — orders wait to be dispatched by hand');
} else {
  scheduler.start(SKILLSPACE_HOME, {
    // 0 here is "unconfigured": lib/scheduler treats anything below its floor as
    // absent and takes its own default rather than honouring a cadence nobody
    // chose. Passing the raw value through keeps that decision in one place.
    intervalMs: schedulerIntervalMs,
    childEnv,
    // WHICH AGENT AN ORDER GETS, resolved through the same function both
    // agent-spawning routes use, with the order record standing in for the
    // request body - the field is `agent` on both. That is not a coincidence
    // worth exploiting cheaply: it is the only way this stays in step with the
    // routes, and routes/common.js records what a hand-copy of this rule costs.
    // Specifically inherited: {"agent": 5} is REFUSED rather than read as absent
    // and silently handed AGENTS[0]. An order record is a file on disk a human
    // can edit, so that shape is reachable here too.
    //
    // Returns undefined when there is no answer - no agent installed, or a name
    // that is not one - which is lib/scheduler's documented "not now". It leaves
    // the order `queued` for a later tick instead of settling it `failed`, which
    // is what runOrder would do with an absent agent and what would burn a whole
    // backlog the first time an agent binary went missing.
    //
    // It does not throw, and that is the point of routing through resolveAgent
    // rather than indexing AGENTS here: a throwing agentFor costs a warnOnce and
    // a skipped candidate on every tick, forever.
    agentFor: (order) => resolveAgent(AGENTS, order).agent,
    // WHICH AGENT JUDGES: the goal's own PM - the agent that wrote the
    // acceptance criteria is the one that reads the result against them.
    // Resolved through resolveAgent for agentFor's reasons; an uninstalled PM
    // is "not now", and the order waits for its verdict rather than being
    // judged by an agent nobody chose. A human can name another through
    // POST /api/orders/:id/verdict/retry.
    judgeFor: (goal) => resolveAgent(AGENTS, { agent: goal.pmAgent }).agent,
  });
}

// The timeout that bounds a stuck agent is a setTimeout inside THIS process,
// and agents run detached so they never see the signal sent to our group.
// Without this, killing the console leaves credentialed agents running with no
// bound at all - reconcile-on-boot then honestly records the order as
// interrupted while the agent is still writing to the tree.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(130);   // a second ^C means "now"
    shuttingDown = true;
    // FIRST, because the drain below is not unref'd and the scheduler's timer
    // keeps firing inside it: a tick landing there sees the just-cancelled
    // orders as settled, takes the next queued ones, and spawns fresh
    // credentialed agents after "cancelling N running agent(s)" has printed.
    //
    // Being FIRST rather than second is not itself what matters - the four
    // reap calls below are synchronous, so no tick can interleave between them,
    // and swapping the lines is an equivalent mutant. What matters is that
    // stop() is called at all, and before anything that yields past the point
    // where the cancelled order releases its slot. lib/scheduler.js's ordering
    // entry carries the measurements; being first is simply how there is no
    // place left to put the await that would get there.
    //
    // It does not cancel anything already in flight. It stops picking new work;
    // cancelAll() on the next line is what reaps what is running.
    scheduler.stop();
    const n = dispatch.cancelAll() + reapRunning('SIGTERM') + plan.cancelAll() + verdict.cancelAll();
    if (n) console.log(`\n  cancelling ${n} running agent(s)…`);
    // Exit once the socket is closed AND every cancelled order has recorded
    // its outcome.
    //
    // The ordering, which is what this rests on: runOrder deletes from inFlight
    // in a `finally`, and a finally runs AFTER the return expression it guards
    // - so the outcome is on disk before the count can reach zero. Waiting on
    // the count therefore waits on the records, not merely on the agents.
    //
    // Exiting on server.close alone does not: measured at ~4ms, well inside the
    // window where the runner is still flushing the cancelled agent's log, and
    // it left the order reading `running` for reconcile to guess at. That
    // measurement is the motivation; the ordering above is the guarantee, and
    // only the end state - the order reads `cancelled` - is pinned by a test.
    // KNOWN LIMIT, CORRECTED ON NODE 24: this entry used to say "server.close()
    // does not close a client's idle keep-alive socket", and on this runtime it
    // does. Minimal repro, both against a bare http.Server: with one IDLE
    // keep-alive connection held, the close() callback fires in 1ms; with one
    // connection whose REQUEST IS STILL IN FLIGHT - headers sent, body short of
    // its Content-Length, or a response never ended - it does not fire at all
    // within 1500ms.
    //
    // So what holds `closed` false is an unfinished exchange, not an idle
    // socket. For /api/run that is a stream still open: the reap above kills the
    // child, the 'close' handler calls res.end(), and only then does the
    // connection become idle and get dropped. The ~4s figure this note used to
    // quote was measured with an SSE client attached and is not re-measured
    // here; whatever its size now, its cause is the live response and not the
    // keep-alive timeout.
    //
    // That also retires the remedy this note used to name:
    // closeIdleConnections() would not have cut it, because the connection in
    // question is not idle. closeAllConnections() is the one that would, and it
    // would destroy a stream mid-write. Still left alone - the agent is dead
    // well before this either way (the reap above is synchronous), so it is
    // exit latency and not an escaped agent.
    //
    // test/scheduler-api.test.js depends on the in-flight half deliberately: it
    // holds the shutdown drain open with an unfinished request, because that is
    // the only thing that still does.
    let closed = false;
    server.close(() => { closed = true; });
    const drain = setInterval(() => {
      if (closed && agentsRunning() === 0) {
        clearInterval(drain);
        process.exit(0);
      }
    }, 50);
    // The same 5s SIGTERM->SIGKILL escalation the runner applies to orders,
    // applied to /api/run's children, which have no runner to do it for them.
    setTimeout(() => reapRunning('SIGKILL'), 5000).unref();
    // One second longer than that escalation, so a child that ignores SIGTERM
    // is reaped before we stop waiting for it. It is unref'd, but the drain
    // interval above is not, so the loop stays alive long enough for this to
    // fire on an order that never settles.
    setTimeout(() => process.exit(0), 6000).unref();
  });
}

server.listen(PORT, HOST_BIND, () => {
  console.log(`\n  SkillSpace · 技控台  已启动`);
  // The ONLY place the secret is published. Open this link in the browser;
  // a launcher that spawned this process reads it from stdout (see README).
  console.log(`  → http://localhost:${PORT}/?auth=${API_SECRET}`);
  console.log('    （打开上面这条链接进入控制台；每次重启都会换新钥匙）');
  for (const s of listSources()) {
    const tag = s.builtin ? s.label : `自定义 ${s.label}`;
    console.log(`  ${s.exists ? '✓' : '✗'} ${tag}：${s.dir}${s.exists ? `（${s.count} 个 Skill）` : '（目录不存在）'}`);
  }
  console.log(`  检测到 agent：${AGENTS.map((a) => a.id).join(', ') || '（无，请装 codex 或 qodercli）'}\n`);
});
