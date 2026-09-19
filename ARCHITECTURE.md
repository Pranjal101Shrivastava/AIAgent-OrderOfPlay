# Architecture

Detailed design notes for Order of Play. The [README](README.md) covers what the agent does;
this covers how and why it is built the way it is.

---

## 1. Runtime model

The agent is a single published HTML document. It has no build step, no bundler, no
dependencies, and no server. Everything it can do beyond static rendering comes from
**runtime capabilities** granted by the host at page-open time.

Two are declared:

| Capability | Provides | Used for |
| --- | --- | --- |
| `db` | Per-artifact JSON document store, durable across reloads, republishes and devices | Tasks, profile, log |
| `sample` | An authenticated call to Claude on the viewer's own account | The planning/reasoning turn |

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

---

## 2. The turn pipeline

A single user message flows through five stages.

```
┌─────────────┐
│ user text   │
└──────┬──────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ buildPrompt()                                │
│   · behavioural rules (static)               │
│   · today's date, tomorrow's date            │
│   · goals[], habits[]      ← from profile    │
│   · open tasks w/ ids      ← from tasks      │
│   · last 12 log lines      ← from meta/log   │
│   · the user's message                       │
│   · output contract + worked example         │
└──────┬───────────────────────────────────────┘
       │  ≤ 64 KiB
       ▼
┌──────────────────────────────────────────────┐
│ sample(prompt, {cache:false, modelTier, …})  │
└──────┬───────────────────────────────────────┘
       │  { text, truncated, modelTierApplied }
       ▼
┌──────────────────────────────────────────────┐
│ parseLoose(text)  →  { reply, actions[] }    │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ applyActions()  validate → serialise → write │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ db snapshot fires → render()                 │
└──────────────────────────────────────────────┘
```

Note the last step. The page does **not** re-render from its own write. It writes, the store
notifies, and render happens from the snapshot. State has one source of truth.

### Why the model is memoryless by design

`sample` keeps nothing between calls. Every turn ships the full context. This looks wasteful
and is actually the right shape here:

- The state that matters lives in the store, which is authoritative and inspectable.
- There is no drift between "what the model thinks the list is" and what it is.
- A turn can be replayed or debugged from the prompt alone.
- Cache is explicitly disabled (`cache: false`) because an identical message must produce a
  fresh decision — "what next?" asked twice five minutes apart is not the same question.

---

## 3. The action layer

The security and correctness boundary. The model proposes; this layer disposes.

```js
actions.slice(0, 40).forEach(function (a) {
  if (!a || typeof a !== "object") return;
  if (a.op === "add")        { /* validated construction */ }
  else if (a.op === "order") { /* index rewrite */ }
  // … five more
  // anything else: silently ignored
});
```

Validation applied before any write:

| Field | Rule |
| --- | --- |
| `day` | `someday`, or matches `/^\d{4}-\d{2}-\d{2}$/`, else defaults to today |
| `shape` | must be in `["deep","admin","errand","social"]`, else `admin` |
| `size` | must be in `["S","M","L"]`, else `M` |
| `title` | coerced to string, truncated to 200 chars |
| `id` | coerced to string; unknown ids resolve to no-ops |
| batch | capped at 40 actions |

The whitelist is closed. An action naming an op that does not exist does nothing — there is no
dynamic dispatch, no `eval`, no property lookup from model-supplied strings.

### Push detection

The one piece of real domain logic:

```js
var later  = a.day === "someday" || (t.day !== "someday" && String(a.day) > t.day);
var pushes = (t.pushes || 0) + (later ? 1 : 0);
```

ISO date strings compare lexicographically, so `>` is a valid chronological test. Moving a
task *earlier* is not a push — only deferral counts. `someday` is always a deferral.

This counter is then fed back into the next prompt, which is what lets the agent say
"you've moved this four times, what's actually in the way?" The behaviour is emergent from
state, not hardcoded copy.

### Write serialisation

The store is last-writer-wins with no transactions, and the contract requires one write at a
time per document. Actions are therefore compiled into a job list and drained sequentially:

```js
function runSeq(jobs) {
  return jobs.reduce(function (p, j) { return p.then(j); }, Promise.resolve());
}
```

A reorder touching six tasks is six sequential writes, not six concurrent ones. Slower, and
correct.

---

## 4. Storage design

```
tasks/<generated-id>   one document per task
profile/main           one document, two arrays
meta/log               one document, bounded array
```

### Why the log is one document

The store caps total documents per artifact. An append-only event stream at one document per
event would consume that budget and then start failing writes. The log is a ring buffer
inside a single document:

```js
LOG.push({ ts, text });
if (LOG.length > 100) LOG = LOG.slice(-100);
```

Bounded memory, bounded document count, and the last 100 events are far more than the twelve
the prompt actually consumes.

### Why per-viewer private storage is not used

The store offers a per-viewer private subtree. This agent deliberately uses shared documents
instead: it is a single-user tool, the artifact is private to its owner, and shared paths keep
the data readable by the owner from any device. Using the private subtree would have bought
nothing and cost cross-device access.

---

## 5. Failure handling

Every failure mode maps to a stable error code and specific user-facing copy. Nothing retries
automatically.

| Code | Meaning | Response |
| --- | --- | --- |
| `not_granted` | Viewer declined Claude access | Explain, stop asking |
| `rate_limited` | Usage limit reached | Tell the user to wait; never loop |
| `session_expired` | Auth lapsed | Ask for re-sign-in |
| `refused` | Model declined the input | Clear any partial output |
| `cancelled` | User pressed Stop | Silent; restore idle UI |
| `prompt_too_large` | Context exceeded 64 KiB | Suggest clearing finished tasks |
| parse failure | No JSON recoverable | "I garbled that one. Say it again?" |

The retry decision belongs to the user, not the page. An automatic retry on `rate_limited`
would burn the very budget that triggered it.

### Degradation ladder

| Condition | Behaviour |
| --- | --- |
| Both capabilities present | Full agent |
| `db` present, `sample` null | List works, manual controls work, composer explains |
| `db` null, `sample` present | In-memory session, lost on reload |
| Both null | Static example day, fully rendered |
| `localStorage` throws | Tier resets to default; everything else unaffected |

Every storage access is wrapped in `try/catch`, because it can throw in private windows and
return empty under cleared site data.

---

## 6. Interface decisions

**No time axis in the UI.** The strongest expression of the product thesis. Rows are numbered
`1, 2, 3` — an order, not a schedule. There is no hour gutter to argue with.

**Shape as a left stripe.** Colour-coded by `deep` / `admin` / `errand` / `social`, so the
weight of a day is legible before reading any title. This is what makes "I'm tired" a
well-posed question.

**The push badge is the only amber thing on the page.** Semantic colour is spent on exactly
one signal, so it cannot be tuned out.

**Manual controls alongside the agent.** Up, down, and complete buttons exist because a
one-position nudge should not cost a model call. Which controls a user reaches for is itself
a signal about whether the agent's rules need tuning.

**Theme tokens defined three times.** Bare `:root` for light, a `prefers-color-scheme` block
guarded against an explicit light choice, and a `[data-theme="dark"]` block so an explicit
toggle wins in both directions. Any colour defined only inside a media query renders one
theme's text on the other theme's ground.

---

## 7. What would change at scale

Honest notes on where this design stops working.

| Constraint | Current approach | What multi-user would need |
| --- | --- | --- |
| Concurrency | Last-writer-wins | Transactions or per-day leases |
| Context size | Whole task list in every prompt | Retrieval over a task index |
| Habit quality | Append-only list | Periodic consolidation pass; contradiction handling |
| Model control | Tier selector | Direct API with pinned model and effort |
| Scheduling | User-initiated only | Host scheduling layer or a server cron |
| Audit | 100-event ring buffer | Durable append-only log in a real store |

The single-user, zero-cost constraint is what makes the current design correct for its actual
purpose. None of the above is hidden work — each is a deliberate trade recorded here.
