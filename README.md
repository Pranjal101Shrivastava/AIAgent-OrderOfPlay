# Order of Play

**A personal-secretary agent that schedules your day as an ordered queue instead of a calendar.**

Most task tools assume you know *when* you'll do something. Order of Play assumes you don't —
only *which day*. It sequences your work, and when you tell it you're tired, hungry, or
suddenly meeting a friend, it reasons about the change and reshuffles the queue itself.

It also watches what you keep avoiding, and says so.

> **New to AI agents?**
> [**Understanding Order of Play**](docs/UNDERSTANDING-ORDER-OF-PLAY.md) explains all of this
> from scratch — what an AI agent even is, what this one does, and how every part of it works.
> It assumes no technical background and takes you to the point where you could argue with the
> design decisions. Non-technical readers can stop after Part 3.

---

## The problem

Calendar apps model time as fixed slots. That fits meetings. It does not fit a graduate
student or an engineer whose deadlines land on *days* but whose working hours move around
energy, hunger, and interruptions.

Put a 2:15pm block on a deep-work task and one of two things happens: you obey a machine that
knows nothing about your state, or you ignore it and the calendar becomes fiction. Either way
you stop trusting it.

Order of Play removes the time axis entirely.

- Tasks belong to a **day**, never an hour.
- Within a day they have an **order**, not a start time.
- Rescheduling is a conversation, not a drag-and-drop.

---

## What it does

| You say | The agent does |
| --- | --- |
| `4 things due this week, arrange them` | Creates tasks, assigns days, orders each day |
| `I'm sleepy, not starting the write-up` | Moves the heavy task, promotes something lighter |
| `meeting a friend at lunch, shuffle around it` | Re-sequences the rest of the day |
| `done with the emails` | Marks complete |
| `move the paper to next week` | Moves it **and records a push** |
| `I do my best work late at night` | Stores it as a durable habit, uses it in future planning |

### The push counter

The feature that separates this from a to-do list. Every time a task is deferred to a later
day, it earns a push mark. At three, the agent is instructed to stop being polite and ask what
is actually blocking you.

This is the difference between recording avoidance and *noticing* it.

Only deferral counts. Moving work earlier, or pulling it off the someday pile, is never
punished — otherwise the counter would measure activity rather than avoidance.

### Overdue work

A task that sits through its whole day untouched is the most ordinary form avoidance takes, so
it gets its own section at the top of the board, sorted oldest-debt-first, with one control
that rolls it onto today.

Rolling charges one push, because that is exactly the signal this product exists to notice.
Two guards keep it fair rather than punitive: it never happens silently, and a task can be
charged at most once per calendar day — a week away costs one push, not seven.

### Undo

A single turn can produce a dozen writes. When a reshuffle is wrong, `Cmd/Ctrl+Z` puts it
back. Undo covers agent plans, manual edits and rollover alike, because all four go through
one executor.

### Editing without the agent

Rename a task, change its shape or size, move it to another day, or delete it — inline, with
no model call. A one-word rename should not cost a round trip, and manual day changes are
counted as pushes just like the agent's.

### Your data, portable

Export the whole queue — tasks, goals, habits, history — as versioned JSON, and import it
back. Import validates every row through the same normaliser the running app uses, and offers
replace or merge.

### Time that survives travel

Days are anchored to a home timezone you set, not to whatever device you are holding. Boarding
a flight no longer rewrites which day is today.

---

## Architecture

The agent runs as a Claude Artifact — a published page granted runtime capabilities by the
claude.ai host. There is no backend, no server, no API key, and no billing.

```
┌──────────────────────────────────────────────────────┐
│  Browser (the published page)                        │
│                                                      │
│  ┌────────────┐   reads/writes   ┌────────────────┐  │
│  │  UI layer  │ ───────────────► │  Domain state  │  │
│  │  render()  │ ◄─────────────── │  TASKS/PROFILE │  │
│  └────────────┘                  └───────┬────────┘  │
│        │                                 │           │
│        │ user message                    │ persist   │
│        ▼                                 ▼           │
│  ┌────────────┐                  ┌────────────────┐  │
│  │ buildPrompt│                  │ claude.use(    │  │
│  │  + parse   │                  │   "db")        │  │
│  └─────┬──────┘                  └───────┬────────┘  │
└────────┼─────────────────────────────────┼───────────┘
         │ claude.use("sample")            │
         ▼                                 ▼
   ┌───────────┐                  ┌──────────────────┐
   │  Claude   │                  │ Per-artifact     │
   │  (host-   │                  │ document store   │
   │   served) │                  │ (durable)        │
   └───────────┘                  └──────────────────┘
```

### The decide / act split

The model never touches storage. It only ever **proposes** a list of actions; the page
**executes** them.

```
user message ──► buildPrompt() ──► Claude ──► { reply, actions[] }
                                                    │
                                        planActions() validates
                                        every op, then the page
                                        writes the result
```

This is deliberate and it is the core safety property:

- Every action is validated against a closed whitelist of seven ops before it touches the store.
- Dispatch is explicit comparison, never a lookup from a model-supplied string — so
  `__proto__` and `constructor` resolve to nothing.
- Day strings are checked against the real calendar, not just a regex; shapes and sizes are
  clamped to known enums.
- The action batch is capped at 40 to bound the blast radius of a bad response.
- Refused actions are **reported to the user**, not dropped in silence. Safety that hides its
  own operation is just quiet.
- Every mutation is logged with a human-readable reason, which then feeds the next prompt.

A malformed or adversarial model response can produce a *wrong plan*. It cannot produce an
arbitrary write — and a wrong plan is one keystroke from being undone.

### Action schema

| Op | Payload | Effect |
| --- | --- | --- |
| `add` | `title, day, shape, size` | Creates a task at the end of that day |
| `order` | `day, ids[]` | Rewrites the sequence for one day |
| `move` | `id, day` | Reassigns the day; increments `pushes` if later |
| `done` | `id` | Marks complete |
| `drop` | `id` | Deletes |
| `habit` | `text` | Appends a durable observation to the profile |
| `goal` | `text` | Appends a stated goal |

Ids are assigned client-side, so an `add` and an `order` in the same batch can cooperate. An
`order` action can only sequence tasks already on that day — it cannot be used to smuggle a
task somewhere else.

### Data model

```
tasks/<id>      { title, day, shape, size, order, status,
                  pushes, createdAt, doneAt, rolledAt }
profile/main    { goals[], habits[], timeZone, rollover }
meta/log        { entries[] }   # ring buffer, last 100
```

`day` is either an ISO date or the literal `someday`. There is no time field anywhere in the
schema — the constraint is enforced by the data model, not just by prompt instructions.

`shape` (`deep` / `admin` / `errand` / `social`) is what makes energy-aware swaps possible:
"I'm tired" is answerable only if the agent knows which tasks are heavy.

The log is a bounded ring buffer rather than one document per event, because the store caps
total documents and an append-only event stream would exhaust it.

---

## Agent design

The system prompt is assembled per turn from live state — open tasks with ids, which of them
are overdue, which are chronically avoided, the user's goals, learned habits, and the last
twelve log lines. The model is memoryless between calls, so the page supplies the entire
context each time.

The behavioural rules that make it a secretary rather than a chatbot:

- Never assign clock times; only reorder within a day.
- Don't argue with a stated mood — reshuffle instead.
- Call out a task pushed three or more times.
- Deal with overdue work explicitly; never leave it unmentioned.
- Record durable patterns as habits; ignore one-off moods.
- Two sentences maximum.

The habit list is the long game. Week one it's empty and the agent is a smart list. By week
four it has accumulated real observations and its plans reflect them. That quality comes from
accumulated context, not from code.

The prompt lives in its own module (`src/core/prompt.js`) rather than inside a string in an
event handler, because a prompt is program logic. There is a test asserting that the worked
example shown to the model parses with this project's own parser.

### Model tier control

The runtime exposes a coarse `modelTier` selector (`quick` / `default` / `complex`), not a
model id. The page hard-caps this:

```js
var ALLOWED_TIERS = ["quick","default"];
// "complex" is deliberately absent: it cannot be selected, stored, or sent.
```

The tier that actually served each response is read back from the result and displayed, so
substitutions are visible rather than silent.

---

## Engineering notes

**Absence is the default.** `claude.use(name)` resolves `null` whenever a capability isn't
available, and it resolves *after* first paint. The page renders a complete example day
synchronously, then upgrades when capabilities arrive. It never blocks on them and never
assumes they exist.

**One writer.** Agent plans, manual edits, rollover and undo all compile to the same operation
descriptors and go through the same executor. One code path where ordering and failure
handling have to be right, rather than four.

**Writes are serialised.** The store is last-writer-wins with no transactions, so action
batches run through a sequential promise chain rather than `Promise.all` — one write at a time
per document.

**Undo is snapshot-and-diff, not inverse operations.** A snapshot cannot be wrong about what
the state was. Inverting operations individually is where undo implementations corrupt state
silently.

**Subscriptions are registered once**, at boot, never from render code. Subscribing inside a
render path would re-subscribe on every snapshot and loop.

**Errors branch on stable codes**, never on message text, and map to specific user-facing copy.
Nothing retries in a loop — an automatic retry on `rate_limited` would burn the very budget
that triggered it.

**Tolerant JSON parsing.** The model returns raw JSON, but replies can arrive fenced or with
stray prose. The parser tries the whole reply, then a fenced block, then the outermost
brace span, and fails cleanly rather than throwing. Liberal about framing, strict about
content.

---

## Building and testing

Zero npm dependencies. The test runner is `node:test` and the bundler uses only Node builtins;
CI asserts that this stays true.

```bash
node build.mjs      # rebuild dist/order-of-play.html from src/
node build.mjs --check   # verify dist/ is in sync with src/
npm test            # 161 assertions
npm run verify      # check, then test
```

Pure domain logic lives in `src/core/*.js` as real ES modules that the tests import directly.
`build.mjs` sorts them by import graph, strips the module syntax, and inlines them into
`src/shell.html` to produce the single publishable file. The tests therefore exercise exactly
the source the bundler inlines — there is no second copy of the logic to drift.

The bundler fails loudly rather than producing something subtly broken: it refuses
`export default`, refuses non-sibling imports, detects import cycles, and rejects two modules
declaring the same top-level name, since bundled modules share one scope.

CI runs on Node 20 and 22 and also verifies that `dist/` is current, so a core change that was
never rebuilt fails rather than shipping a stale artifact.

---

## Running it

This is a Claude Artifact, not a standalone web app. Publish `dist/order-of-play.html` as an
Artifact with these capabilities declared:

```json
{ "db": {}, "sample": {} }
```

Opening the file directly in a browser renders the full interface with the agent features
inert, because `window.claude` does not exist there. That is the degradation ladder working as
designed.

### Why this deployment target

| | Artifact runtime | Self-hosted + API key |
| --- | --- | --- |
| Cost to run | none | per-token billing |
| Infrastructure | none | server, database, secrets |
| Model pinning | tier only | exact model + effort |
| Clone-and-run | no | yes |

This project deliberately takes the first column. It was built to be *used daily by its
author* at zero marginal cost, and that constraint drove the architecture. The trade-off is
real and is stated here rather than hidden: you cannot pin an exact model, and you cannot run
it without a Claude account.

---

## Limitations

Stated plainly, because they're design consequences rather than bugs:

- **No proactive notifications.** The agent acts when opened; it cannot wake you at 8am.
  Scheduled execution would require the host's scheduling layer.
- **Storage is model-adjacent, not transactional.** Last-writer-wins, no rollback at the
  storage level. Undo is application-level, held in memory for the session.
- **Model tier, not model identity.** See above.
- **Habit learning is append-only.** Observations accumulate but are never revised or
  contradicted. A wrong inference persists until manually cleared. This is the most
  interesting unfinished part of the project.
- **Single user.** Shared state, permissions and concurrency are all absent by design.
- **Rollover charges a push for a day passing.** Defensible, but a judgement call — you might
  have been ill. Mitigated by never being silent and never charging twice in a day.

---

## Repository layout

```
.
├── README.md                    this file
├── ARCHITECTURE.md              detailed design notes
├── CHANGELOG.md                 what changed and when
├── LICENSE
├── package.json                 scripts only; zero dependencies
├── build.mjs                    the bundler
├── .github/workflows/ci.yml     tests on Node 20 and 22
├── docs/
│   ├── README.md                demo notes
│   └── UNDERSTANDING-ORDER-OF-PLAY.md    the from-scratch explanation
├── src/
│   ├── core/                    pure domain logic — no DOM, no IO
│   │   ├── day.js               calendar-day arithmetic and timezones
│   │   ├── task.js              schema, coercions, day grouping
│   │   ├── actions.js           the action whitelist — the safety boundary
│   │   ├── rollover.js          overdue work and the fairness rule
│   │   ├── history.js           undo/redo by snapshot and diff
│   │   ├── backup.js            versioned export and import
│   │   ├── parse.js             tolerant reply reading, error copy
│   │   ├── prompt.js            prompt assembly and size budgeting
│   │   └── settings.js          home timezone, rollover policy
│   └── shell.html               interface and wiring
├── dist/
│   └── order-of-play.html       ← the file you publish
└── test/                        161 assertions, node:test, zero deps
```

---

## License

MIT — see [LICENSE](LICENSE).
