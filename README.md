# Order of Play

**A personal-secretary agent that schedules your day as an ordered queue instead of a calendar.**

Most task tools assume you know *when* you'll do something. Order of Play assumes you don't —
only *which day*. It sequences your work, and when you tell it you're tired, hungry, or
suddenly meeting a friend, it reasons about the change and reshuffles the queue itself.

It also watches what you keep avoiding, and says so.

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
                                        applyActions() validates
                                        every op, then writes
```

This is deliberate and it is the core safety property:

- Every action is validated against a whitelist of seven ops before it touches the store.
- Unknown ops are silently dropped rather than executed.
- Day strings are regex-checked, shapes and sizes are clamped to known enums.
- The action batch is capped at 40 to bound the blast radius of a bad response.
- Every mutation is logged with a human-readable reason, which then feeds the next prompt.

A malformed or adversarial model response can produce a *wrong plan*. It cannot produce an
arbitrary write.

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

### Data model

Three collections in the artifact's document store:

```
tasks/<id>      { title, day, shape, size, order, status, pushes, createdAt, doneAt }
profile/main    { goals[], habits[] }
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

The system prompt is assembled per turn from live state — open tasks with ids, the user's
goals, learned habits, and the last twelve log lines. The model is memoryless between calls,
so the page supplies the entire context each time.

The behavioural rules that make it a secretary rather than a chatbot:

- Never assign clock times; only reorder within a day.
- Don't argue with a stated mood — reshuffle instead.
- Call out a task pushed three or more times.
- Record durable patterns as habits; ignore one-off moods.
- Two sentences maximum.

The habit list is the long game. Week one it's empty and the agent is a smart list. By week
four it has accumulated real observations and its plans reflect them. That quality comes from
accumulated context, not from code.

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

**Writes are serialised.** The store is last-writer-wins with no transactions, so action
batches run through a sequential promise chain rather than `Promise.all` — one write at a time
per document.

**Subscriptions are registered once**, at boot, never from render code. Subscribing inside a
render path would re-subscribe on every snapshot and loop.

**Errors branch on stable codes**, never on message text, and map to specific user-facing copy.
Nothing retries in a loop.

**Tolerant JSON parsing.** The model returns raw JSON, but replies can arrive fenced or with
stray prose. The parser tries the whole reply, then a fenced block, then the outermost
brace span, and fails cleanly rather than throwing.

---

## Running it

This is a Claude Artifact, not a standalone web app. `src/order-of-play.html` is the complete
source, but it depends on the `window.claude` runtime that the claude.ai viewer injects —
opening the file directly in a browser renders the UI with all agent features inert.

To run it, publish the file as an Artifact with these capabilities declared:

```json
{ "db": {}, "sample": {} }
```

A demo video is in `docs/` (see below).

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
- **Storage is model-adjacent, not transactional.** Last-writer-wins, no rollback. Fine for a
  single-user queue; wrong for anything with contention.
- **Model tier, not model identity.** See above.
- **Habit learning is append-only.** Observations accumulate but are never revised or
  contradicted. A wrong inference persists until manually cleared.
- **No timezone handling.** Dates are local-browser dates. Travel across zones will misfile a
  task.

---

## Repository layout

```
.
├── README.md                 this file
├── ARCHITECTURE.md           detailed design notes
├── LICENSE
├── src/
│   └── order-of-play.html    complete agent source (UI + prompt + action layer)
└── docs/                     demo video
```

---

## License

MIT — see [LICENSE](LICENSE).
