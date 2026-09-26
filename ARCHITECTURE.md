# Architecture

Detailed design notes for Order of Play. The [README](README.md) covers what the agent does;
this covers how and why it is built the way it is. For an explanation that assumes no prior
knowledge, see [Understanding Order of Play](docs/UNDERSTANDING-ORDER-OF-PLAY.md).

---

## 1. Runtime model

The agent is a single published HTML document. It has no bundler dependencies, no third-party
packages, and no server. Everything it can do beyond static rendering comes from **runtime
capabilities** granted by the host at page-open time.

Two are declared:

| Capability | Provides | Used for |
| --- | --- | --- |
| `db` | Per-artifact JSON document store, durable across reloads, republishes and devices | Tasks, profile, settings, log |
| `sample` | An authenticated call to Claude on the viewer's own account | The planning/reasoning turn |
| `downloads` | A viewer-confirmed file save | Exporting a backup |

Each is obtained asynchronously:

```js
const db = await claude.use("db");   // null when unavailable
```

`null` is not an error condition — it is the ordinary case for any view that isn't a Claude
viewer. The three null causes (not served, not granted, module failed) are deliberately
indistinguishable, so the page cannot branch on *why*; it can only degrade.

### Timing contract and its consequence

Capabilities resolve **after** the first synchronous script run, and are unordered against
`DOMContentLoaded`. This rules out the usual "fetch, then render" shape.

The page therefore boots in three phases:

```
1. synchronous   render(EXAMPLE)        complete UI, example data, marked as such
2. async         use("sample") → ask    enables the composer
3. async         use("db") → subscribe  first snapshot replaces example data
```

Phase 1 is what a screenshot, a link preview, or a viewer with no capabilities will see. It
is a full working interface rather than a spinner. `isExample` gates a banner that disappears
the moment real data arrives.

### Source layout

The deployment target is one file. The source is not, because domain logic trapped inside a
single HTML document cannot be tested — and the action layer, which this document calls the
security boundary, was consequently never exercised by anything.

```
src/core/*.js      pure ES modules; no DOM, no IO. Tests import these directly.
src/shell.html     interface and wiring, with a /*__CORE__*/ marker
build.mjs          topological sort, strip module syntax, inline
dist/*.html        the single publishable file, committed
```

The property that matters: **the tests exercise exactly the source the bundler inlines.**
There is no second copy of the logic to drift out of sync. Section 9 covers the build.

---

## 2. The turn pipeline

A single user message flows through six stages.

```
┌─────────────┐
│ user text   │
└──────┬──────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ buildPrompt()                                │
│   · behavioural rules (static)               │
│   · today's date (in the user's home zone)   │
│   · goals[], habits[]      ← from profile    │
│   · overdue tasks w/ ids   ← computed        │
│   · all open tasks w/ ids  ← from tasks      │
│   · chronically pushed     ← computed        │
│   · last 12 log lines      ← from meta/log   │
│   · the user's message                       │
│   · output contract + worked example         │
└──────┬───────────────────────────────────────┘
       │  promptFits() — UTF-8 bytes, ≤ 64 KiB
       ▼
┌──────────────────────────────────────────────┐
│ sample(prompt, {cache:false, modelTier, …})  │
└──────┬───────────────────────────────────────┘
       │  { text, truncated, modelTierApplied }
       ▼
┌──────────────────────────────────────────────┐
│ readAgentReply(text) → { reply, actions[] }  │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ planActions()  pure: validate → op list      │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ execute()  serialise writes to the store     │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ db snapshot fires → render()                 │
└──────────────────────────────────────────────┘
```

Note the last step. The page does **not** re-render from its own write. It writes, the store
notifies, and render happens from the snapshot. State has one source of truth.

Note also the split between the last two stages. Planning is pure and produces a list of
operation descriptors; executing performs IO. That separation is what makes the whole action
layer testable without a browser or a store.

### Why the model is memoryless by design

`sample` keeps nothing between calls. Every turn ships the full context. This looks wasteful
and is actually the right shape here:

- The state that matters lives in the store, which is authoritative and inspectable.
- There is no drift between "what the model thinks the list is" and what it is.
- A turn can be replayed or debugged from the prompt alone.
- Cache is explicitly disabled (`cache: false`) because an identical message must produce a
  fresh decision — "what next?" asked twice five minutes apart is not the same question.

### Why the prompt is a module

`src/core/prompt.js` exists because a prompt is program logic: it determines behaviour as
directly as a conditional does. Inside a template literal in an event handler, a behavioural
rule cannot be tested, reviewed in isolation, or diffed meaningfully.

As a module it can be asserted on, and is. Among the tests: that overdue work gets its own
labelled section, that completed tasks never enter the context, that history is capped at
twelve lines, and that the worked example shown to the model parses with this project's own
parser — so the instructions cannot drift from the code that reads them.

---

## 3. The action layer

The security and correctness boundary. The model proposes; this layer disposes.

```js
if (AGENT_OPS.indexOf(action.op) < 0) {
  reject(`unknown op ${JSON.stringify(action.op)}`);
  return;
}
if (action.op === "add")        { /* validated construction */ }
else if (action.op === "order") { /* index rewrite */ }
// … five more
```

The whitelist is closed. There is no dynamic dispatch, no `eval`, and no property lookup from
a model-supplied string — which is why `{"op":"__proto__"}` and `{"op":"constructor"}`
resolve to nothing rather than to something callable. Both are in the test suite.

Validation applied before any write:

| Field | Rule |
| --- | --- |
| `day` | `someday`, or a **real calendar date**, else defaults to today |
| `shape` | must be in `["deep","admin","errand","social"]`, else `admin` |
| `size` | must be `S`/`M`/`L`, case-insensitively, else `M` |
| `title` | coerced to string, whitespace collapsed, truncated to 200 chars |
| `id` | must match an existing task; unknown ids are refused, not ignored |
| batch | capped at 40 actions; the overflow is reported |

"Real calendar date" is load-bearing. `/^\d{4}-\d{2}-\d{2}$/` accepts `2026-02-30`, so
`isIsoDay` round-trips the parts through a UTC date and compares back.

### Purity, and what it buys

`planActions` performs no IO, reads no clock and generates no randomness. `today`, `now` and
the id factory are injected:

```js
planActions(actions, { tasks, profile }, { today, now, makeId })
  // → { ops, log, rejected, tasks, profile, alarms }
```

The same input therefore always produces the same plan, and a plan is an ordinary data
structure that can be asserted on. Non-determinism is pushed to the edges; the middle is
testable.

It also means the planner can simulate as it goes. A working copy of the task list is mutated
while the plan is built, so later actions in a batch see the effect of earlier ones — which is
why an `add` followed by an `order` referencing the new task now works. Ids are assigned
client-side for the same reason.

### Rejections are surfaced, not swallowed

Previously an unrecognised action was dropped silently. That felt safe and was not: the user
saw a reply claiming three things had changed, watched two change, and had no way to learn the
third was refused. Silence turns a partial failure into a false belief.

Every refusal is now collected with a reason and shown:

> Ignored one instruction: unknown op "wipeEverything".

Safety that hides its own operation is not trustworthy; it is merely quiet.

### Push detection

The domain's central rule:

```js
const deferred = isAfter(action.day, task.day);
const pushes   = coerceCount(task.pushes) + (deferred ? 1 : 0);
```

All the subtlety is in the day ordering, where `someday` sorts after every dated day:

```js
export function compareDays(a, b) {
  if (a === b) return 0;
  if (a === SOMEDAY) return 1;
  if (b === SOMEDAY) return -1;
  return a < b ? -1 : 1;     // ISO dates compare correctly as strings
}
```

Two properties fall out without special cases. Moving to `someday` is the furthest deferral
and counts; moving *from* `someday` onto a real day is pulling work in and does not. Moving a
task earlier is never punished — otherwise the counter would measure activity rather than
avoidance, and the number would mean nothing.

### Write serialisation

The store is last-writer-wins with no transactions, and the contract requires one write at a
time per document. Operations are therefore drained sequentially:

```js
function runSeq(jobs) {
  return jobs.reduce((p, j) => p.then(j), Promise.resolve());
}
```

A reorder touching six tasks is six sequential writes, not six concurrent ones. Slower, and
correct.

### One executor

Agent plans, manual edits, rollover and undo all compile to the same operation descriptors —
`create`, `patch`, `delete`, `profile` — and pass through the same `execute`. There is exactly
one code path in the application that writes, so ordering and failure handling have one place
to be correct rather than four.

---

## 4. Storage design

```
tasks/<client-id>      one document per task
profile/main           goals[], habits[], timeZone, rollover
meta/log               one document, bounded array
```

Task documents carry `title, day, shape, size, order, status, pushes, createdAt, doneAt,
rolledAt`. There is no time field. The product thesis is enforced by the schema rather than by
prompt instructions alone: a contributor cannot quietly reintroduce scheduling, because there
is nowhere to put an hour.

`order` is a position within a day, not a global rank — two tasks on different days are both
legitimately `0`.

`rolledAt` exists for one narrow purpose: it records the calendar day a task last took a
rollover push, so the same task cannot be charged twice in one day however many times the app
is opened. A small field encoding a fairness rule.

### Why settings live in the store

Tier selection stays in `localStorage`, because it is a per-device convenience and losing it
costs nothing. Home timezone and rollover policy do not: they change what the agent computes,
so they belong next to the data they affect and must follow the user across devices. A queue
that rolls over on the laptop but not the phone is worse than one that never rolls over.

### Why the log is one document

The store caps total documents per artifact. An append-only event stream at one document per
event would consume that budget and then start failing writes. The log is a ring buffer inside
a single document, bounded at 100, of which the prompt consumes the last twelve.

### Why per-viewer private storage is not used

The store offers a per-viewer private subtree. This agent deliberately uses shared documents
instead: it is a single-user tool, the artifact is private to its owner, and shared paths keep
the data readable by the owner from any device. Using the private subtree would have bought
nothing and cost cross-device access.

---

## 5. Time

Every calendar application eventually learns this lesson, and this one learned it late.

"Today" was computed from the browser's local date. Fly between continents and the browser's
idea of today jumps, misfiling work against the wrong day. Days are now anchored to a stored
home timezone:

```js
export function todayIn(timeZone, now = new Date()) {
  if (typeof timeZone === "string" && timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(now);
      // assemble YYYY-MM-DD from labelled parts
    } catch (err) { /* unknown zone: fall through */ }
  }
  return localDay(now);
}
```

Three decisions in a short function. `formatToParts` rather than a formatted string, because
locale formatting varies and labelled parts cannot be surprised by it. An unknown zone falls
back rather than throwing, so a stale stored preference cannot break the page. The default is
empty — *follow this device* — which is correct for the majority and honest about the fact
that nobody has said otherwise.

### The grouping bug

Related, and worth recording because it is the kind that survives review. Tasks were bucketed
by a chain of equality tests with a catch-all:

```js
const slot = t.day === TODAY      ? today
           : t.day === addDays(1) ? tomorrow
           : t.day === "someday"  ? someday
           :                        later;    // ← everything else
```

A task from last Tuesday matches none of the tests and lands in "Later this week", displayed
as upcoming. For a deferral tracker this is close to the worst available bug: the tasks most
likely to be avoided were the ones most likely to be hidden.

The general lesson is that **a chain of equality tests ending in a catch-all is a place to
look for bugs**, because the catch-all silently absorbs every case nobody considered.

### Rollover

Overdue work now has its own section and an explicit roll-forward. The contentious decision is
whether rolling counts as a push, and it does: a task that sat through a whole day untouched
is avoidance in its most ordinary form, and not counting it would let the most-avoided work
keep the cleanest record. Two guards keep that fair rather than punitive — it is never silent,
and `rolledAt` caps it at one charge per calendar day.

---

## 6. Undo

A single turn can produce a dozen writes. When a reshuffle is wrong, the user's only previous
recourse was to reconstruct the old order from memory — a worse job than the one they
delegated.

There are two ways to build undo. **Inverse operations** require every operation to have a
correct inverse, the inverses to compose in reverse, and no mistakes — and a mistake corrupts
state silently, which is discovered weeks later. **Snapshot and diff** copies the state before
each change and, to undo, generates the writes that close the gap.

This project takes the second. A snapshot cannot be wrong about what the state was. The cost
is memory, and for a single-user queue of a few hundred tasks that cost is irrelevant: a clean
trade of something plentiful for the elimination of a bug class.

```js
export function planRestore(current, target) {
  // in target, not current → create
  // in both, fields differ → patch only the changed fields
  // in current, not target → delete
  // profile differs        → one profile write
}
```

Only changed fields are patched, so undoing a three-task reorder writes three documents rather
than the whole queue. The result is the same operation descriptors everything else produces,
handed to the same executor.

The stack is bounded at 25 and recording a new change clears the redo branch — the behaviour
every text editor has trained people to expect.

---

## 7. Failure handling

Every failure mode maps to a stable error code and specific user-facing copy. Nothing retries
automatically.

| Code | Meaning | Response |
| --- | --- | --- |
| `not_granted` | Viewer declined Claude access | Explain, stop asking |
| `rate_limited` | Usage limit reached | Tell the user to wait; never loop |
| `session_expired` | Auth lapsed | Ask for re-sign-in |
| `refused` | Model declined the input | Clear any partial output |
| `cancelled` | User pressed Stop | Silent; restore idle UI |
| `prompt_too_large` | Context exceeded 64 KiB | Name what to prune, specifically |
| parse failure | No JSON recoverable | "I garbled that one. Say it again?" |

The retry decision belongs to the user, not the page. An automatic retry on `rate_limited`
would burn the very budget that triggered it.

Codes are looked up with `hasOwnProperty`, not a bare property access, because
`ERROR_COPY["toString"]` would otherwise return a function and render something absurd.

### Tolerant parsing

The prompt asks for raw JSON and nothing else. That is followed most of the time, and *most of
the time* is not a contract. The reader makes three attempts — the whole reply, a fenced
block, then the outermost brace span — and returns `null` rather than throwing.

Having found something, it stops being accommodating: an `actions` field that is a string is
an error, not something to be coerced into a single-element array. **Liberal about how the
message is wrapped, strict about what it says.**

### Degradation ladder

| Condition | Behaviour |
| --- | --- |
| All capabilities present | Full agent |
| `db` present, `sample` null | List, editing, rollover and undo work; composer explains |
| `db` null, `sample` present | In-memory session, lost on reload |
| `downloads` null, inside a viewer | Export is disabled rather than left to fail silently |
| No host at all (opened as a file) | Export falls back to a blob link, which works there |
| All null | Static example day, fully rendered |
| `localStorage` throws | Tier resets to default; everything else unaffected |

**A page cannot download anything by itself.** An `<a download>` pointing at a blob URL is
ignored by the artifact viewer, without an error — so an export button built that way appears
to work and does nothing, which is the worst available outcome for a backup feature. Saving
goes through `downloads.save()`, which asks the viewer and can refuse for several ordinary
reasons (`declined`, `rate_limited`, `too_large`); each gets its own copy. The blob path is
kept only for the hostless case, where it is the one that works.

Every storage access is wrapped in `try/catch`, because it can throw in private windows and
return empty under cleared site data.

---

## 8. Interface decisions

**No time axis in the UI.** The strongest expression of the product thesis. Rows are numbered
`1, 2, 3` — an order, not a schedule. There is no hour gutter to argue with.

**Overdue is the first thing on the page**, in the one alarm colour, with a single control
that resolves it. A debt you have to scroll to find is a debt you will not pay.

**Shape as a left stripe.** Colour-coded by `deep` / `admin` / `errand` / `social`, so the
weight of a day is legible before reading any title. This is what makes "I'm tired" a
well-posed question.

**Semantic colour is rationed.** Amber means pushed; red means late or destructive. Nothing
else competes for either, so neither can be tuned out.

**Manual controls alongside the agent.** Up, down, complete, and now a full inline editor,
because a one-word rename should not cost a model call. Which controls a user reaches for is
itself a signal about whether the agent's rules need tuning.

**Editing counts pushes too.** Moving a task to a later day by hand is the same act as asking
the agent to; counting only one would make the number a measure of how you phrased things.

**Theme tokens defined three times.** Bare `:root` for light, a `prefers-color-scheme` block
guarded against an explicit light choice, and a `[data-theme="dark"]` block so an explicit
toggle wins in both directions. Any colour defined only inside a media query renders one
theme's text on the other theme's ground.

---

## 9. The build

`build.mjs` uses only Node builtins. The project has zero npm dependencies and CI asserts that
this stays true — no lockfile, nothing in `dependencies` or `devDependencies`.

The transform is deliberately dull: sort core modules by their import graph, strip the module
syntax, concatenate into one shared scope, and substitute into the shell's `/*__CORE__*/`
marker.

Because that scope is flat, the build **fails loudly** rather than emitting something subtly
broken:

- `export default` is refused — named exports only.
- Imports that are not siblings are refused.
- Import cycles are detected and named.
- Two modules declaring the same top-level name is an error, since after bundling they would
  collide.

`node build.mjs --check` rebuilds and compares against the committed `dist/`, so a core change
that was never rebuilt fails CI rather than shipping a stale artifact.

---

## 10. Testing strategy

The obvious objection to testing an agent is that the model is non-deterministic. The answer
is to test everything except the model, which turns out to be almost all of it.

**Not tested:** whether Claude gives good advice. That is an evaluation problem and belongs in
a different kind of harness.

**Tested — 163 assertions:**

- Every coercion, with hostile input: `2026-02-30`, negative push counts, objects where
  strings belong, `__proto__` as a shape.
- Every action, valid and invalid, with tests written as claims about behaviour rather than
  implementation — *"order cannot smuggle a task onto another day"*.
- The push rule in all four directions, including both `someday` cases.
- Rollover fairness: a week away costs one push, not seven.
- Undo and redo, including that recording a new change clears the redo branch.
- The parser, against fenced, prose-wrapped and malformed replies.
- Backup round-trips, including files with deliberately corrupt rows.
- The prompt, including that its worked example parses with this project's own parser.

**A linkage test** cross-references every identifier the shell calls against the core's real
exports, so a typo'd core call fails CI. It was verified by introducing a deliberate typo and
confirming it was caught — a test never seen to fail is a test not known to work.

**46 browser checks** drive the built artifact in Chromium: degraded mode with no capabilities,
the full agent path against a scripted reply that is fenced, prose-wrapped and carries a bogus
action, editing, rollover, undo, settings, and mobile layout. These verify the file users
actually load, not merely the functions inside it.

CI runs the suite on Node 20 and 22.

---

## 11. What would change at scale

Honest notes on where this design stops working.

| Constraint | Current approach | What multi-user would need |
| --- | --- | --- |
| Concurrency | Last-writer-wins | Transactions or per-day leases |
| Context size | Whole task list in every prompt | Retrieval over a task index |
| Habit quality | Append-only list | Periodic consolidation; contradiction handling |
| Model control | Tier selector | Direct API with pinned model and effort |
| Scheduling | User-initiated only | Host scheduling layer or a server cron |
| Audit | 100-event ring buffer | Durable append-only log in a real store |
| Undo | In-memory, per session | Persisted server-side history |

The context row bites first. Every open task goes into every prompt, which is correct and cheap
at a few hundred tasks and impossible at ten thousand. Past that point the design has to change
shape — retrieve the relevant subset rather than send everything — which is a genuinely
different architecture.

The single-user, zero-cost constraint is what makes the current design correct for its actual
purpose. None of the above is hidden work; each is a deliberate trade recorded here.
