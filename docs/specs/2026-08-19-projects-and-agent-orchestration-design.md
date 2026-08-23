# SkillSpace — Projects & Agent Orchestration

**Date:** 2026-08-19 · **Status:** draft, awaiting review
**Method:** superpowers `brainstorming`

---

## 1. Problem

SkillSpace reads skill directories and dispatches one-shot commands. It has no
memory of what it ran, no concept of a project, and no way to put several agents
on the same body of work.

Concretely, today:

- The only persisted state is `recentDirs`.
- `JOBS` is an in-memory `Map` capped at 20 entries that evicts the oldest, and
  it dies with the process.
- `/api/run` — the path that actually spawns an agent — **creates no record at
  all.** It streams output to whoever is watching and forgets it happened.

So there is nothing to manage and nothing to monitor. This design adds both.

## 2. Decisions taken with the user

| Question | Answer |
|---|---|
| Does SkillSpace run agents, or observe them? | **Run them.** SkillSpace is the dispatcher. |
| Where do tasks come from? | **PM-mode.** State a goal → a PM agent decomposes it into work orders → workers execute → results route back to the PM for a verdict. |
| What is a project? | **A git repository or a plain directory**, holding many tasks. |
| Spec scope | All four subsystems in one document (against the recommendation to slice; recorded so the tradeoff is visible). |

### Assumptions taken, flagged for easy reversal

- Local, single user, no auth. Persistence is flat JSON on disk.
- Monitoring is **durable** (survives restart) with live streaming on top.
- No spend cap in v1 — see §9.

## 3. The model

Three objects. Everything else is derived.

### Project

```
{ id, name, kind: "git" | "dir", path, branch?, skillSources: [dir],
  agents: [agentId], concurrency: number, createdAt }
```

`kind` is detected, not declared: a `.git` directory present → `git`, else `dir`.
This matters because it decides isolation (§5).

### Goal

What the human states. One goal fans out into many orders.

```
{ id, projectId, text, status: "planning"|"running"|"done"|"failed",
  pmAgent, orderIds: [], createdAt }
```

### Work order

The unit an agent executes and the unit the board monitors.

```
{ id, projectId, goalId, seq, title, prompt, acceptance,
  agent, cwd, status, exitCode?, verdict?, error?,
  createdAt, startedAt?, finishedAt? }
```

`acceptance` is the PM's stated criteria for that order. It is what the verdict
is judged against, and it is the reason a worker's own claim of success is not
taken at face value.

### Status lifecycle

```
queued → dispatched → running → succeeded ─┐
                              → failed  ───┼→ verified
                              → cancelled  └→ rejected
```

`succeeded` means the process exited 0. `verified` means the PM agent read the
result against `acceptance` and accepted it. **They are different claims and are
stored separately** — a worker exiting 0 while doing the wrong thing is the most
common multi-agent failure, and collapsing the two hides it.

## 4. Flow

```
human states goal
   → SkillSpace dispatches PM agent (cwd = project path, read-only intent)
   → PM returns work orders as JSON  [{title, prompt, acceptance}, ...]
   → SkillSpace persists orders as queued
   → scheduler dispatches up to `concurrency` at a time
        each order: prepare cwd (§5) → spawn agent → stream to log → record exit
   → on completion, PM is dispatched once more per order with the result
   → verdict recorded: verified | rejected
```

The PM's decomposition arrives as JSON on stdout. This reuses the mechanism the
expert-classification flow already uses (a token, a callback, a parsed result),
rather than inventing a second one.

**If the PM returns unparseable output**, the goal goes to `failed` with the raw
output retained. It is never silently retried — a PM that cannot produce orders
is a prompt problem the human needs to see.

## 5. Isolation — derived from project kind

Two agents editing one working tree concurrently will corrupt each other. The
project's kind decides what is possible:

| kind | isolation | concurrency |
|---|---|---|
| `git` | `git worktree add` per running order, under `~/.skillspace/worktrees/<orderId>`, removed on completion | up to `concurrency` (default 2) |
| `dir` | none available | **forced to 1**, stated in the UI |

Plain directories cannot be isolated, so they are serialized rather than
silently allowed to collide. The UI says why, at the point where it matters.

**Known cost, recorded:** a fresh worktree does not inherit `node_modules`.
Projects needing install will pay that per order. v1 does not solve this;
it surfaces it in the order log rather than pretending it is free.

Agents always run with `cwd` set to the worktree or project path — **never** the
SkillSpace install directory.

## 6. Persistence

Flat JSON under `~/.skillspace/`, outside both the app and the user's repos:

```
~/.skillspace/
  projects.json          all projects
  goals/<goalId>.json
  orders/<orderId>.json
  logs/<orderId>.log     append-only, streamed while running
  worktrees/<orderId>/   transient
```

Writes are atomic (write temp, rename) so a crash mid-write cannot leave a
half-parsed record. Logs append as the process emits, so a crashed run still has
everything up to the crash.

This replaces the 20-item in-memory `JOBS` map. Nothing is evicted; the board can
answer "what happened last Tuesday."

## 7. API

```
GET    /api/projects                  list
POST   /api/projects                  {name, path} → detects kind
DELETE /api/projects/:id              record only; never touches the directory
POST   /api/projects/:id/goals        {text} → dispatch PM, return goal
GET    /api/goals/:id                 goal + its orders
GET    /api/orders?project=&status=   board query
GET    /api/orders/:id/log            SSE while running, file when finished
POST   /api/orders/:id/cancel         SIGTERM, then SIGKILL after 5s
POST   /api/orders/:id/retry          new order, same prompt, fresh worktree
```

`DELETE /api/projects/:id` removing only the record — never the user's files —
is a deliberate safety property, not an omission.

## 8. Surfaces

Three, all on the existing console's token system and grammar:

1. **Project rail** — replaces today's source list as the primary axis. Sources
   become a property of a project rather than the top-level nav.
2. **Board** — orders grouped by status for the active project. Each row: seq,
   title, agent, status, duration. The existing bracket-numeral and status-dot
   grammar carries over.
3. **Order drawer** — extends the current run drawer: prompt, acceptance, live
   log, exit code, verdict.

The card wall stays. It becomes the way to compose a one-off order against the
active project, not the whole application.

## 9. What v1 does not do, stated plainly

- **No spend cap.** N agents on long tasks cost real money and nothing stops it.
  Concurrency is the only limit, and it is a weak one.
- **No approval gate.** A dispatched worker modifies its worktree immediately.
- **No `node_modules` reuse** across worktrees (§5).
- **No multi-user, no auth.** Anything reachable on `localhost:4177` can dispatch
  agents against any registered project.
- **No cross-machine.** Everything is local.

## 10. Error handling

- Agent binary missing at dispatch → order `failed`, message names the binary.
  (Detection already fixed in `b4379f3`.)
- Agent exits non-zero → `failed`, exit code and full log retained, PM still gets
  the result so a verdict exists.
- Worktree creation fails (dirty tree, bad branch) → order `failed` before any
  agent spawns; nothing half-created is left behind.
- SkillSpace restarts while orders are `running` → on boot, any `running` order
  is marked `interrupted`, because its child process is gone. It is never assumed
  to have succeeded.

## 11. Testing

- Model + persistence: atomic write survives simulated crash; a `running` order
  is reconciled to `interrupted` on boot.
- Isolation: two concurrent orders on a git project get distinct worktrees; a
  `dir` project refuses concurrency > 1.
- Lifecycle: exit 0 → `succeeded`; non-zero → `failed`; cancel → SIGTERM path.
- PM parse failure → goal `failed`, raw output retained, no retry.
- End-to-end against a real agent (`opencode` works today; `claude` needs re-auth).

## 12. Open

- Retry semantics for a `rejected` verdict: new order, or re-run the same one?
  Leaning new order, so the history of what was rejected survives.
- Whether the PM should see other orders' results when judging one.
