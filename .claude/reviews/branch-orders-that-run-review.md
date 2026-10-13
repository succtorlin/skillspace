# Branch Review: feat/orders-that-run (Plans 2a + 2b)

**Reviewed**: 2026-08-26
**Branch**: feat/orders-that-run -> main (45 commits, 35 files, +15141/-37)
**Mode**: Local branch-diff (no PR — branch is unpushed; GitHub publish skipped)
**Decision**: REQUEST CHANGES

## Summary

Two plans' worth of work: persisted work orders that run one agent against one
project (2a), and goals that a PM agent decomposes into those orders (2b). The
security-sensitive surfaces are sound — every injection vector checked came back
clean, and the path guard, the credential allowlist and the loopback bind are all
correctly built. The blocking findings are size and a wrong engines floor, not
security.

This code has already been through ten task-level gates and one whole-branch
review, so the absence of correctness findings here is expected rather than
surprising. What follows is what those gates did not look at: packaging, file
size against the project's own stated ceiling, and cross-route guard consistency.

## Findings

### CRITICAL
None.

### HIGH

**H1 — Two files exceed the project's own 800-line ceiling, and this branch grew both.**
- `server.js`: 1220 lines (CLAUDE-adjacent convention and the repo's own comments
  state 800). Recorded as a known limit in-tree, but the limit is still breached
  and this branch added to it.
- `public/app.js`: 949 lines, +209 on this branch.

Neither is a defect in behaviour. Both are flagged because the repo states the
rule and the branch moved away from it. `server.js` is the more urgent of the two:
it holds routing, agent detection, the SSE run route, shutdown, and the static
file server, and Plan 2c adds a scheduler that will want a home.

### MEDIUM

**M1 — `engines.node: ">=18"` is wrong, and this branch is what made it wrong.**
The branch added `"test": "node --test \"test/**/*.test.js\""`. Node's test-runner
glob support landed in v21; on the declared floor of 18 the pattern is treated as
a literal path and `npm test` fails to find any tests. `lib/runner.js` also uses
`node:string_decoder` (fine on 18) but the suite is the binding constraint.
Set `engines.node` to `">=21"` (or `">=22"` to match what is actually exercised).

**M2 — Two per-request reads open every record in a directory.**
`orders.countToday()` opens every order file for the project, and `GET /api/goals`
opens every goal file. `countToday` runs inside `plan.decompose`'s synchronous
prologue, which `POST /api/goals` reaches inside the request tick — measured at
6-21ms at suite store sizes, growing with the day's orders. Fine now; it is the
kind of thing that is invisible until a board polls it. The index `lib/orders`
already wants for `list()` fixes both.

### LOW

**L1 — `POST /api/projects` does not carry the `isTopLevelNavigation` guard that
`POST /api/orders`, `POST /api/orders/:id/dispatch` and `POST /api/goals` all carry.**
Defensible as written: the guarded routes are the ones that spawn agents, and a
clicked link issues a GET, so a link cannot reach a POST route regardless. Noted
only because project registration is the step that chooses *where* an agent will
later run, and the asymmetry is not explained in either file.

**L2 — `.gitignore` does not cover the store directories** (`projects/`, `orders/`,
`goals/`, `worktrees/`). Not reachable at the default store root (`~/.skillspace`),
so this only matters if someone sets `SKILLSPACE_HOME=.` inside the repo. `*.log`
is already covered.

## Checked and clear

| Surface | Result |
|---|---|
| `execSync(\`command -v ${bin}\`)` — server.js:319 | Clean. `bin` comes from a hardcoded literal array (`claude`/`codex`/`opencode`/`qodercli`); no user input reaches the shell. |
| git invocation — lib/worktrees.js | Clean. `execFile('git', args)` with an argv array, no shell. Ids validated by `PLAIN_ID`, branches by `assertBranch` (rejects leading `-`, `.lock`, `..`, `@{`, control chars). |
| Path traversal — lib/store.js `abs()` | Correct. Resolves the base first, then compares against `base + path.sep` rather than a bare prefix, so `/base/store-evil` is rejected. |
| Credential handling | No hardcoded secrets. `childEnv` is a required parameter in both `dispatch.runOrder` and `plan.decompose` — deliberately not defaulted, because the only sensible default is `process.env`, which is the leak the allowlist exists to prevent. |
| Network exposure | Loopback-only bind via `HOST_BIND`; global `isCrossOrigin || !hostAllowed` check ahead of route dispatch. |
| Input validation | Body cap with an oversize sentinel, aborted-body path, `plainIdFrom` on every `:id`, start-anchored 400-vs-500 split. |
| TODO / FIXME / HACK | None. |
| Emoji in source | None. |
| `console.log` | 7, all boot/shutdown progress lines on the server's own stdout. Appropriate. |

## Validation Results

| Check | Result |
|---|---|
| Type check | Skipped — plain JS, no tsconfig, no build step (by design) |
| Lint | Skipped — not configured |
| Tests | **Pass — 360/360** |
| Build | N/A — zero dependencies, no build step |

## Files Reviewed

Source (17): `server.js` M, `lib/{store,projects,orders,worktrees,runner,dispatch,goals,pm,plan}.js` A/M,
`routes/{projects,orders,goals,common,deps}.js` A, `public/{app,pure}.js` M
Tests (13): all A/M. Docs (2). Config (3).
