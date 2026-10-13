'use strict';

// The guards two route modules must not hand-copy.
//
// routes/orders.js and routes/goals.js are the two routes that spawn a
// credentialed agent, so they need the same admission decisions. Those
// decisions were duplicated character for character, and the copy was already
// drifting: routes/orders.js records that its own caller-fault regex was once
// anchored at the END, which matched nothing and reported every over-long
// prompt as a 500. A hand-copied guard drifts; that is the whole argument for
// this file.
//
// It requires nothing from server.js, so a route can take these directly while
// still receiving its capabilities through the factory. server.js takes
// isPlainId from here too, so there is genuinely ONE definition of what an id
// may look like rather than one per file.

// Ids reach the store as path segments. store.abs() guarantees containment
// within the store root but NOT within the intended collection, so an id of
// "../projects" would resolve inside the root and reach another namespace.
const isPlainId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s);

// What both agent-spawning routes need from the server. Shared rather than
// written twice: they have identical needs, and the two lists drifting would
// cost the boot-time check for whichever key one of them forgot.
const RUN_ROUTE_REQUIRED = Object.freeze([
  'root', 'sendJson', 'readBody', 'OVERSIZE', 'ABORTED',
  'plainIdFrom', 'isTopLevelNavigation', 'denyNavigation',
  'AGENTS', 'maxConcurrentRuns', 'childEnv',
]);

// A message from anything a catch can receive. `e.message` alone is undefined
// for a thrown string or a non-Error rejection, and "undefined" is what then
// lands on a record or in a log as the only diagnosis. lib/goals.failPlanning
// guards the same case one layer down for the same reason.
function errorMessage(e) {
  return String((e && e.message) || e);
}

// Whether a thrown error is the CALLER's fault, so a route answers 400 rather
// than blaming itself with a 500.
//
// Anchored at the START. lib/orders throws "prompt is too long (100001 >
// 100000)" and lib/goals "text is too long (...)" - the phrase is not at the
// end of either, so an alternation anchored there matched nothing and every
// oversize input came back 500: SkillSpace claiming it broke, for an input the
// user only needs to shorten. Mutation testing cannot catch that on its own -
// deleting the dead alternative is behaviourally identical to keeping it - so
// both routes carry a boundary test at exactly the limit.
//
// Matching on prose is still the real weakness. The intended fix is for
// lib/orders and lib/goals to tag their caller faults (e.code = 'EINVAL') so
// this becomes a field check rather than a regex over a message anyone might
// reword. That fix now has ONE site to land in instead of two, which is half
// the reason this file exists.
function clientFault(e) {
  return /^\w+ (is required|is too long|must not start with)/.test(errorMessage(e));
}

// Which agent a request asked for, or why it cannot have one.
// Returns { agent } or { error }.
//
// An ABSENT agent defaults to the first installed one. A named-and-unrecognised
// one is REFUSED rather than silently substituted, because both routes persist
// the resolved id onto the record - so a substitution makes the store assert
// the caller asked for an agent they never named.
//
// PRESENT BUT NOT A STRING is refused too, and that is the case a mutation
// sweep found open in both routes: `typeof body.agent === 'string' ? ... : ''`
// reads {"agent": 5} as ABSENT and hands back AGENTS[0] with a 200, while
// {"agent":"5"} gets a 400. Same silent substitution, one type away. The
// obvious patch, `body.agent || ''`, is only partial - 0, false and NaN still
// fall through to the default - so the test is on presence, not truthiness.
//
// What actually closes it is `named` being decided by three STRICT comparisons
// rather than by coercing a non-string to ''. The explicit typeof branch below
// is redundant for the STATUS - no agent id equals a number or an object, so
// the lookup would refuse them anyway - and a mutation sweep correctly reports
// deleting it as equivalent. It is kept for the MESSAGE: `${{}}` interpolates
// as "[object Object]", which tells the caller nothing about what they sent.
//
// undefined and null BOTH count as absent, deliberately. null is how a JSON
// client serialises a field it does not have, not a caller naming something;
// refusing it would break a legitimate request to make a point. An empty string
// is absent for the same reason - it is a cleared form field, which is what the
// console's own agent <select> produces when nothing is installed.
function resolveAgent(AGENTS, body) {
  const list = Array.isArray(AGENTS) ? AGENTS : [];
  const raw = body ? body.agent : undefined;
  const named = raw === undefined || raw === null || raw === '';

  if (!named && typeof raw !== 'string') {
    return { error: `未知的 agent：${JSON.stringify(raw)}（可用：${available(list)}）` };
  }
  if (named) {
    const first = list[0];
    return first ? { agent: first } : { error: '没有检测到可用的 agent' };
  }
  const found = list.find((a) => a && a.id === raw);
  return found
    ? { agent: found }
    : { error: `未知的 agent：${raw}（可用：${available(list)}）` };
}

function available(list) {
  return list.map((a) => a && a.id).filter(Boolean).join(', ') || '无';
}

// `?project=` on the two list routes the board polls (plan 3, Task 0).
// ABSENT lists every project's records - callers and tests rely on that, and
// it is a request someone made on purpose. PRESENT BUT BLANK is refused: it is
// what a cleared filter or an unset variable produces, and it used to answer
// with the whole store, which a board would then render as one project's.
// Returns { filter } or { error }.
function projectFilterFrom(searchParams) {
  if (!searchParams.has('project')) return { filter: {} };
  const v = searchParams.get('project');
  if (!v.trim()) return { error: 'project must not be empty (omit it to list every project)' };
  return { filter: { projectId: v } };
}

module.exports = {
  isPlainId, RUN_ROUTE_REQUIRED, errorMessage, clientFault, resolveAgent, projectFilterFrom,
};
