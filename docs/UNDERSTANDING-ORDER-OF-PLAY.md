# Understanding Order of Play

### A complete explanation, starting from nothing

---

This document assumes you know nothing about AI agents, nothing about
programming, and nothing about this project. By the end you will understand all
three — not in outline, but well enough to argue with the design decisions.

It is written for several people at once:

- **Someone non-technical** — a recruiter, a manager, a friend — who wants to
  know what this is and why it took thought. Read Parts 1 to 3 and stop. That
  is about twenty minutes and it is the whole idea.
- **A student learning about AI agents.** Read Parts 1 to 5. Part 4 is where
  the general lessons live: they apply to any agent, not just this one.
- **An engineer evaluating the work.** Parts 4 to 7 are for you. Part 8 maps
  every file in the repository.

Nothing is assumed from an earlier section except what that section taught.
Every technical term is defined the first time it appears, and again in the
glossary at the end. Code appears from Part 4 onwards, always with a plain
explanation next to it, so you can skip the code and still follow the argument.

---

## Table of contents

**Part 1 — What an AI agent actually is**
1.1 Ordinary software, and what it cannot do
1.2 What a language model is
1.3 What a language model is not
1.4 From model to agent
1.5 The four parts of any agent
1.6 Why agents are hard

**Part 2 — The problem this agent solves**
2.1 Why calendars break
2.2 The idea: a queue, not a timetable
2.3 Shape and size
2.4 The push counter

**Part 3 — What using it is like**
3.1 A week with it
3.2 What it does that a to-do list cannot

**Part 4 — How it works**
4.1 One turn, end to end
4.2 The prompt, in full
4.3 The decide/act split
4.4 The action whitelist
4.5 Memory
4.6 What the model never sees

**Part 5 — The engineering**
5.1 Where it runs
5.2 The data model
5.3 Never trust your inputs
5.4 Detecting avoidance
5.5 Undo
5.6 Time is the hard part
5.7 Reading a reply that is not quite JSON
5.8 Failing well
5.9 How you test an agent
5.10 One file, many modules

**Part 6 — Honest limitations**

**Part 7 — What would change at scale**

**Part 8 — The code, file by file**

**Part 9 — Glossary**

**Part 10 — Where to learn more**

---
---

# Part 1 — What an AI agent actually is

## 1.1 Ordinary software, and what it cannot do

Almost every program you have ever used works by following rules a person wrote
down in advance.

A calculator adds two numbers because someone wrote a rule: *when the user
presses `+`, add.* A banking app moves money because someone wrote out every
step of moving money. The rules can be enormously complicated — millions of
lines — but they share one property: **a human anticipated the situation and
decided in advance what should happen.**

This is a strength. It makes software predictable, testable and auditable. If a
calculator gives the wrong answer, there is a specific rule that is wrong, and
someone can find it and fix it.

It is also a hard ceiling. Consider asking a program:

> I'm sleepy and I don't want to start the write-up. Can you shuffle things
> around?

To handle that with rules, someone must anticipate it. And not just that
sentence — every way anyone might express it. "I'm knackered." "Brain's not
working." "Can we do something easy first." Each is a different string of
characters. A rule-based program sees no connection between them at all.

Worse, even if it recognised the sentence, it would have to *decide what to do*:
which task is the heavy one, what is light enough to do instead, whether moving
the write-up to tomorrow is reasonable or whether tomorrow is already full. That
is judgement, and judgement is exactly what a written-down rule is not.

For about fifty years, this was simply the edge of what software did. Then a
different kind of program arrived.

## 1.2 What a language model is

A **language model** is a program that predicts text.

That sentence is accurate and sounds far too small, so let us take it slowly.

Imagine a system whose only skill is: given a piece of text, guess what comes
next. Given `the capital of France is`, it answers `Paris`. Given
`Dear Sir or`, it answers `Madam`.

Now consider how such a thing could be built. Nobody writes the rules. Instead
it is **trained**: shown an enormous quantity of text — books, articles,
documentation, conversation, code — and adjusted, over and over, to get better
at predicting the next piece. The adjustment is automatic. It happens billions
of times. What it adjusts are **parameters**: numbers inside the model, so many
of them that no person could inspect them meaningfully.

Nobody ever tells it grammar. Nobody tells it that Paris is in France. Those
facts and patterns settle into the parameters as a *side effect* of getting good
at prediction, because you cannot reliably predict the word after
`the capital of France is` without, in some functional sense, having stored
that fact.

Here is the part that genuinely surprised the field. If you make the model big
enough, train it on enough text, and then simply *ask it things*, it turns out
to be able to do a great deal more than autocomplete. Summarise this. Translate
that. Explain this error. Rewrite this warmly. None of those were programmed.
They are consequences of having learned the shape of language extremely well,
because all of them are, structurally, "what text should follow this text?"

A few terms you will meet:

- **Token.** Models do not read letters or words exactly; they read tokens,
  which are chunks of text roughly the size of a short word or word-fragment.
  "Understanding" might be two tokens. Everything a model reads and writes is
  counted in tokens, and that is usually what you pay for and what limits how
  much it can consider at once.
- **Context window.** The maximum amount of text — measured in tokens — the
  model can be given at once. Everything the model "knows" about your specific
  situation has to fit in there.
- **Prompt.** The text you give the model. All of it. Instructions, background,
  data, question — from the model's side it is one piece of text to continue.
- **Inference.** One run of the model: text in, text out.

## 1.3 What a language model is not

This matters more than what it is, because almost every serious mistake in
building with these systems comes from getting this wrong.

**It does not remember.** A language model has no memory between runs. Ask it
something, then ask a follow-up, and the second run knows nothing about the
first — unless you paste the first conversation back in. Chat products create
the *illusion* of memory by resending the conversation each time. The model is
reading the whole history afresh, every single time.

This is not a flaw to be worked around. It is a property to design with, and
Part 4 shows how this project does.

**It does not know what is true.** It was trained to produce *plausible* text,
and plausible and true overlap most of the time but not always. When it produces
something confident and wrong, that is called a **hallucination**. It is not
lying — lying requires knowing better. It is generating text that fits the
pattern. A model will invent a citation, a function name, or a task id with
exactly the same tone it uses for things it has right.

**It is not deterministic.** Ask the same question twice and you can get two
different answers. Usually similar, sometimes not. Normal software gives the
same output for the same input; this does not.

**It cannot do anything.** By itself a model only emits text. It cannot save a
file, send an email, or reorder your tasks. It has no hands.

That last point is where agents come in.

## 1.4 From model to agent

An **AI agent** is a model that has been given hands, and a loop.

Concretely, an agent is a program that:

1. gathers relevant information and puts it into a prompt,
2. asks a model what should happen,
3. **does** something as a result — changes data, calls another program, writes
   a file,
4. observes what happened, and often goes back to step 1.

The model supplies judgement. The surrounding program supplies memory,
information, and the ability to act. Neither is the agent by itself. This is
worth being firm about, because "AI agent" is used loosely enough to mean almost
anything. A chatbot that only talks is not an agent. A script that calls a model
and prints the result is not an agent. What makes something an agent is that
**a model's output changes the state of the world**, and the program keeps going
afterwards.

Order of Play is a small, sharply defined agent. Its world is your task queue.
Its judgement is about sequencing work. Its hands can create a task, reorder a
day, move something to another day, mark work done, delete it, or record
something it has learned about you. That is the entire set. It cannot email
anyone, spend money, or touch anything outside that queue — and Part 4.4
explains why that boundary is enforced in code rather than merely requested in
the prompt.

## 1.5 The four parts of any agent

Nearly every agent, however large, has the same four parts. Knowing them lets
you take apart any agent system you meet.

**Perception — what the agent can see.**
The model knows only what is in the prompt. So "perception" means: what does the
program gather and include? Order of Play includes today's date, every open
task with its identifier, which are overdue, what you have said your goals are,
what it has learned about how you work, and a slice of recent history. It
deliberately excludes completed tasks, because they are clutter rather than
context.

**Decision — the model's judgement.**
One inference. Given everything above plus your message, what should change?

**Action — what the agent can do.**
The fixed, small set of operations. In this project: seven. Anything the model
proposes outside that set does not happen.

**Memory — what survives.**
The model forgets everything between runs, so memory lives in the program. Here
it is three things in a database: the tasks themselves, a profile of goals and
learned habits, and a bounded log of what has happened.

Take any agent — a coding assistant, a customer-service bot, a research
tool — and you can locate these four. Most of the interesting engineering in
agents is in perception (what to include, given a limited context window) and
action (what to permit, and how to stop the rest).

## 1.6 Why agents are hard

If a model gives a bad answer in a chat window, you read it, shrug, and rephrase.
If a model gives a bad answer to an agent, **something happens.**

This changes the engineering problem completely, in four ways.

**The model will sometimes be confidently wrong.** Not occasionally in theory —
routinely in practice. It will reference a task that does not exist. It will
propose a day in a format nobody asked for. Any agent that assumes a
well-behaved response is an agent that corrupts its own data eventually.

**You cannot test it the way you test other software.** Normal testing says:
given this input, assert this exact output. You cannot do that when the same
input can produce different text twice running. Part 5.9 is entirely about what
you *can* test, which turns out to be most of what matters.

**The instructions are not a contract.** You can write "never assign clock
times" in the prompt, and it will be followed nearly always. Nearly is not a
guarantee. A rule that must hold has to be enforced in code. Prompt instructions
shape behaviour; code sets limits. Confusing the two is the most common security
mistake in agent design.

**The text is untrusted input.** This is subtle and important. When the model
returns text, that text is not a trustworthy command from a trusted colleague.
It is data from a source that is usually right and sometimes not — and which, if
your prompt includes anything from outside (a web page, an email, a shared
document), could have been *influenced* by whoever wrote that outside content.
Treating model output as data to be validated, rather than instructions to be
followed, is the single most important habit in this field.

Every one of these four shows up concretely in Part 4.

---
---

# Part 2 — The problem this agent solves

## 2.1 Why calendars break

Calendars model time as slots. 9:00 standup. 14:15 write-up. That works
beautifully for meetings, because a meeting genuinely is an agreement about a
moment: other people are involved, and 14:15 means 14:15.

It works badly for everything else.

Put "write the evaluation section" in a 14:15 slot. Two things can happen. You
obey it — starting deep work at 14:15 because a machine that knows nothing about
your state said so. Or you ignore it, and now your calendar contains a lie.

The second is what actually happens, and the damage compounds. Once a few
entries are fiction, you stop reading the calendar as a description of your day.
You stop trusting it. And an untrusted planning tool is worse than none, because
you are still paying the cost of maintaining it.

The underlying mistake is a mismatch of precision. For a graduate student or an
engineer, most work has a **deadline on a day** — this is due Thursday — but no
natural hour. The hour depends on energy, hunger, when a meeting overran,
whether the thing you tried first worked. Recording an hour you invented as
though it were a commitment stores false precision, and false precision is worse
than none: it looks like information.

## 2.2 The idea: a queue, not a timetable

Order of Play removes the time axis entirely.

- A task belongs to a **day**. Never an hour.
- Within that day, tasks have an **order** — first, second, third.
- Changing the plan is a conversation, not a drag-and-drop.

That is the whole product thesis, and the interesting thing is how much follows
from it.

You are never asked a question you cannot answer. "Which day is this due?" is
answerable. "What hour will you have the energy for this?" is not, and every
calendar asks it constantly.

The plan can also survive contact with reality. If deep work is third in
today's queue and you get to it at 4pm instead of 11am, nothing has gone wrong —
it was third, and it still is. Compare a timetable, where a single overrun
invalidates everything after it.

And the order itself carries meaning. First is what you should do next. Not "at
09:00" — *next*. That is a claim the tool can actually stand behind.

The constraint is enforced in the data, not just in the interface. There is no
time field anywhere in the schema. A future contributor cannot quietly
reintroduce scheduling, because there is nowhere to put it. That is a deliberate
technique: **when a principle matters, make the data model unable to express its
violation.**

## 2.3 Shape and size

Two attributes make the rest work.

**Shape** is what kind of work it is: `deep`, `admin`, `errand`, or `social`.

This exists so the agent can answer "I'm tired." That sentence is only
actionable if something knows which tasks are heavy. Without shape, the best any
tool can do is acknowledge your mood. With it, "put something lighter next" is a
computation: find the admin or errand task, move it up, push the deep work
later.

**Size** is `S`, `M` or `L` — roughly how much of a lift it is. Not minutes.
Minutes would smuggle the time axis back in through the side door.

Shape also appears in the interface as a coloured stripe down the left of each
row, so the weight of a day is legible before you read a single title. Four deep
tasks in a row look like four deep tasks in a row.

## 2.4 The push counter

This is the feature that makes it something other than a prettier to-do list.

Every time a task is moved to a **later** day, it earns a push mark. The count
lives on the task. Three pushes, and the agent is instructed to stop being
polite and ask what is actually blocking you.

The reasoning is worth spelling out. To-do lists record what you intend to do.
They are silent about what you keep *not* doing — which is the more useful
signal, and the one you are least likely to notice yourself. A task you have
moved five times is not a scheduling problem. It is a task you are avoiding, and
the reason is usually one of: it is bigger than the title suggests, it is
blocked on someone else, it needs a decision you have not made, or you do not
actually intend to do it. All four have different fixes, and none of them is
"move it to tomorrow again."

The counter turns something invisible into something visible. That is the
product in one sentence.

Two details keep it honest:

**Only deferral counts.** Moving work *earlier* is not punished. Nor is pulling
something off the "someday" pile onto a real day. If the counter went up on any
movement, it would measure activity rather than avoidance, and the number would
mean nothing. (Part 5.4 shows the three lines of code that make this true, and
the test that keeps it true.)

**Letting a day pass counts too, but only once.** If a task sits through its day
untouched, that is avoidance in its most ordinary form, so rolling it forward
charges a push. But it charges *one*, no matter how long you were away — a week
of not opening the app costs one push, not seven — and the rollover never
happens silently. You either ask for it or turn it on yourself.

---
---

# Part 3 — What using it is like

## 3.1 A week with it

**Monday.** You open it and type:

> four things due this week: the eval write-up, the Work4Flow email thread,
> groceries, and I should call Ananya back

It creates four tasks, assigns them days, and puts them in an order. The
write-up is deep work and lands first on Monday. The email thread is admin and
sits behind it. Groceries go to Tuesday. Ananya is social and goes to Wednesday.
You did not specify any of that. It inferred shapes from the wording and spread
the load.

**Tuesday.** You type:

> I'm sleepy, not starting the write-up

It does not encourage you. It moves the write-up to Wednesday, promotes the
email thread to first, and says one sentence about why. The write-up now has one
push mark.

**Wednesday.** You are in a meeting that overruns:

> meeting a friend at lunch, shuffle around it

It re-sequences the rest of the day. No clock times are involved, because there
are none to involve.

**Thursday.** You move the write-up again. Second push.

**Friday.** You try to move it a third time. This time the reply is different:

> That is the third time the write-up has moved. What is actually in the way?

You type back that you are stuck on which baseline to compare against. It
records that as a habit — *gets blocked on methodology decisions before
starting* — and now that observation is in every future prompt. Next time it
sees a task shaped like that stalling, it has seen the pattern before.

**Week four.** The habits list has real content: when you do deep work well,
what kinds of task you consistently overestimate, which days are already
overloaded. The plans it makes reflect all of it. That quality did not come from
better code. It came from accumulated context — which is a general truth about
agents worth holding onto.

## 3.2 What it does that a to-do list cannot

| You say | What happens |
| --- | --- |
| `4 things due this week, arrange them` | Creates tasks, infers shapes, assigns days, orders each day |
| `I'm sleepy, not starting the write-up` | Moves the heavy task, promotes something lighter |
| `meeting a friend at lunch, shuffle around it` | Re-sequences the rest of the day |
| `done with the emails` | Marks it complete |
| `move the paper to next week` | Moves it **and records a push** |
| `I do my best work late at night` | Stores it as a durable habit and uses it in future planning |

A to-do list can do line one, badly, if you fill in every field yourself. It
cannot do any of the others, because each requires judgement about what your
sentence *means* for a specific queue on a specific day.

---
---

# Part 4 — How it works

This is where the ideas from Part 1 become concrete. Code appears here, but
every piece is explained in plain language first, and you can skip the code
blocks without losing the argument.

## 4.1 One turn, end to end

You type a sentence and press send. Seven things happen.

```
1. buildPrompt()     assemble everything the model needs to see
2. promptFits()      confirm it fits the size limit
3. sample()          one call to Claude — the only model call
4. readAgentReply()  find and parse JSON in whatever came back
5. planActions()     validate every proposed action; compile to operations
6. execute()         write the operations to storage, one at a time
7. render()          redraw from storage
```

Three properties of this pipeline are worth noticing, because they are the
design.

**There is exactly one model call per message.** No loop, no chain of agents
calling agents. Reordering a day is a single judgement, and a single judgement
needs a single call. Multi-step agent loops are fashionable and are the right
answer to genuinely multi-step problems; using one here would add latency, cost
and failure modes to buy nothing.

**Steps 4 and 5 assume the model got it wrong.** Not as pessimism — as the
default case that must be handled correctly. Step 4 assumes the response may not
be valid JSON. Step 5 assumes the actions inside may be invalid, reference
things that do not exist, or be things the model made up entirely.

**Step 7 redraws from storage, not from what step 5 decided.** The page writes,
the store notifies, and the redraw reads the store. If a write silently failed,
the interface shows the failure rather than a comforting fiction. State has one
source of truth.

## 4.2 The prompt, in full

Because the model remembers nothing, every turn ships the whole world. Here is
the actual structure, assembled fresh each time by `src/core/prompt.js`:

```
You are Pranjal's personal secretary. You run a task queue, not a calendar.

HARD RULES
- Never assign clock times. Days are fixed; hours are theirs to choose...
- If they say they are tired, hungry, low or busy, do not argue...
- Moving a task to a later day is a push. If a task has been pushed 3 or
  more times, say so plainly and ask what is actually blocking it...
- Work listed as OVERDUE has already had a day pass without being done...
- Protect their goals from their moods, warmly...
- When you learn something durable about how they work, record it...
- Keep the reply to at most two sentences...

TODAY IS 2026-09-26. Tomorrow is 2026-09-27.

THEIR GOALS
- finish the thesis draft

WHAT YOU HAVE LEARNED ABOUT THEM
- works best after 10pm
- consistently underestimates admin tasks

OVERDUE — a day has already passed on these
- id=t7f2 | "Finish the retrieval eval write-up" | was due 2026-09-24

ALL OPEN TASKS
- id=t7f2 | "Finish the retrieval eval write-up" | day=2026-09-24 |
  shape=deep | size=L | order=0 | pushed=2x
- id=t8a1 | "Reply to the Work4Flow thread" | day=2026-09-26 |
  shape=admin | size=S | order=0 | pushed=0x

CHRONICALLY AVOIDED
(none)

RECENT HISTORY
- 2026-09-24: moved "Finish the retrieval eval write-up" to 2026-09-25 (push 2)
- 2026-09-25: completed "Groceries + pick up the package"

THEIR MESSAGE
I'm sleepy, not starting the write-up

Reply with ONLY a JSON object: {"reply":"...","actions":[...]}
...seven action shapes, then a worked example...
```

Several decisions are embedded here.

**Every task carries its id.** The model must be able to name what it wants to
change. Those ids come straight back in the actions, and step 5 checks each one
against reality.

**Completed tasks are excluded.** They are not context, they are noise, and they
consume context window.

**Overdue work gets its own section** even though those tasks also appear in the
full list. Repetition is cheap, and a labelled section is far more reliable than
hoping the model compares dates correctly. Giving a model a pre-computed
conclusion is almost always better than giving it the raw material and trusting
the arithmetic.

**History is capped at twelve lines.** Enough for continuity, bounded so the
prompt cannot grow without limit.

**The behavioural rules are prompt instructions and only that.** "Never assign
clock times" is a strong nudge, and it is not a guarantee. The guarantee is
structural: there is no time field, so a clock time has nowhere to go.

One more detail that is easy to miss: the prompt lives in its own module rather
than inside a string in an event handler. A prompt is program logic — it
determines behaviour as surely as an `if` statement does. Buried in the UI, a
behavioural rule cannot be reviewed, diffed meaningfully, or tested. In its own
file it can be, and it is: there is a test asserting that the worked example
shown to the model actually parses with the project's own parser.

## 4.3 The decide/act split

This is the most important idea in the project, and it generalises to every
agent you will ever build.

**The model never touches storage.**

It does not have a database connection. It cannot write. All it does is return
a description of what it thinks should happen. A separate layer decides whether
any of that is allowed, and that layer does the writing.

```
user message ──► buildPrompt() ──► Claude ──► { reply, actions[] }
                                                     │
                                         planActions() validates
                                         every action, then the
                                         page executes the result
```

The consequence is precise, and worth stating exactly:

> A malformed or adversarial model response can produce a **wrong plan**. It
> cannot produce an **arbitrary write**.

That distinction is the whole security story. A wrong plan is recoverable — you
can see it, and Part 5.5 gives you one keystroke to undo it. An arbitrary write
is not recoverable, and an agent that permits one is one bad response away from
destroying its own data.

Compare the alternative that many tutorials suggest: give the model a set of
tools, let it call them directly, and trust the tool definitions to constrain
it. That works until it does not. The safe version inverts the trust: the model
*proposes*, the program *disposes*, and the program assumes the proposal may be
nonsense.

## 4.4 The action whitelist

There are exactly seven things the agent can do:

| Op | What it does |
| --- | --- |
| `add` | Create a task on a day |
| `order` | Rewrite the sequence for one day |
| `move` | Change a task's day — and count a push if it is later |
| `done` | Mark complete |
| `drop` | Delete |
| `habit` | Record something durable about how you work |
| `goal` | Record a stated goal |

The list is **closed**. Not "these are the documented ones" — these are the only
ones that exist. The code is a chain of explicit comparisons:

```js
if (AGENT_OPS.indexOf(action.op) < 0) {
  reject(`unknown op ${JSON.stringify(action.op)}`);
  return;
}
if (action.op === "add")   { /* validated construction */ }
else if (action.op === "order") { /* index rewrite */ }
// ...five more
```

That shape is deliberate. There is no dynamic dispatch — no
`handlers[action.op]()`, no `eval`, no looking up a function by a name the model
supplied. If the model returns `{"op": "deleteEverything"}`, nothing is found,
nothing runs, and the attempt is recorded. The test suite proves this for
ordinary nonsense and for names that try to exploit JavaScript's object model:

```js
test("prototype-polluting op names do not dispatch", () => {
  const result = planActions(
    [{ op: "__proto__" }, { op: "constructor" }, { op: "toString" }],
    state([]), ctx()
  );
  assert.deepEqual(result.ops, []);
  assert.equal(result.rejected.length, 3);
});
```

`toString` and `constructor` exist on every JavaScript object. Under a lookup-based
dispatcher they would resolve to *something*, and that something would then be
called. Under explicit comparison they resolve to nothing.

Beyond the op name, every field is validated:

| Field | Rule |
| --- | --- |
| `day` | `someday`, or a real calendar date; otherwise defaults to today |
| `shape` | must be one of the four; otherwise `admin` |
| `size` | must be `S`, `M` or `L`; otherwise `M` |
| `title` | coerced to text, whitespace collapsed, truncated to 200 characters |
| `id` | must match an existing task; unknown ids are refused |
| batch | capped at 40 actions |

The batch cap deserves a word. Forty is far more than any legitimate turn needs.
It exists to bound the damage of a pathological response — a model that gets
stuck repeating itself cannot produce ten thousand writes.

**One recent change is worth calling out, because it is a design lesson.**
Previously, an unrecognised action was dropped silently. That felt safe and was
not: the user saw a reply saying "moved three things and reordered your day",
watched two things move, and had no way to know the third was refused. Silence
turns a partial failure into a false belief. Now every refusal is collected and
surfaced:

> Ignored one instruction: unknown op "wipeEverything".

**Safety that hides its own operation is not trustworthy. It is just quiet.**

## 4.5 Memory

The model forgets everything. So memory is the program's job, and it takes three
forms with three different lifetimes.

**The tasks themselves.** One document per task. This is the state the whole
thing exists to manage.

**The profile** — your stated goals, and habits the agent has noticed. This is
the long game. Week one it is empty and the agent is a smart list. By week four
it has accumulated genuine observations and its plans reflect them. Nothing in
the code got better; it simply knows more. That is the general shape of how
agents improve in practice, and it is why the *perception* half of an agent
usually matters more than the model you picked.

**The log** — a bounded record of what has happened, the last twelve lines of
which go into every prompt. This is what lets the agent say "you have moved this
four times" without anyone hardcoding that sentence. The behaviour is emergent
from state.

The log is stored as one document holding a capped list, rather than one
document per event. That is a constraint of the storage layer — it caps total
documents per artifact, and an append-only stream of events would eventually
exhaust the budget and start failing writes. So it is a ring buffer: push on the
end, drop from the front past 100.

## 4.6 What the model never sees

Just as instructive as what is included.

- **No completed tasks.** Noise.
- **No timestamps beyond the date.** Including times would invite the model to
  reason about times, and the product thesis is that it should not.
- **No raw storage access.** It sees a rendered summary, not the database.
- **No ability to select a model.** The interface exposes a coarse quality tier —
  quick or standard — and the most capable, longest-thinking tier is
  unreachable: not merely hidden in the interface, but absent from the list the
  code will accept.

```js
var ALLOWED_TIERS = ["quick","default"];
// "complex" is deliberately absent: it cannot be selected, stored, or sent.
```

A test asserts that the string never appears in a request in the built file. The
reason is cost discipline: nothing in this product needs the expensive tier, and
a control that *can* be set wrongly eventually will be.

---
---

# Part 5 — The engineering

This part is for readers who want to see how the ideas are actually built. Each
section takes one problem, shows the solution, and draws out the lesson that
applies beyond this project.

## 5.1 Where it runs

There is no server. No database you administer, no API key, no hosting bill.

The agent is a **Claude Artifact**: a single HTML page published to claude.ai,
which the host grants two runtime capabilities.

| Capability | What it provides |
| --- | --- |
| `db` | A small document store, private to this artifact, durable across reloads and devices |
| `sample` | An authenticated call to Claude, billed to whoever is viewing |

Each is requested asynchronously and may not arrive:

```js
const db = await claude.use("db");   // null when unavailable
```

`null` is not an error. It is the ordinary case for any viewer without those
capabilities. This produces a hard constraint with a pleasant consequence:
**the page must be fully functional before it knows whether it has any
capabilities at all.** So it boots in three phases:

```
1. synchronous   render an example day — a complete, working interface
2. async         sample arrives  → the composer starts working
3. async         db arrives      → real data replaces the example
```

Phase 1 is what a screenshot, a link preview, or a viewer with nothing enabled
sees: not a spinner, not an error, but a populated interface that shows exactly
what the product is. The cost is that every capability access must be guarded.
The benefit is that the page degrades in stages rather than failing.

| Condition | Behaviour |
| --- | --- |
| Both capabilities | Full agent |
| `db` only | List works, editing works, composer explains why it cannot plan |
| `sample` only | Works for the session; lost on reload |
| Neither | Static example day, fully rendered |
| `localStorage` throws | Tier resets to default; nothing else affected |

That last row matters more than it looks. Browser storage throws in private
windows and returns empty under cleared site data. Every access is wrapped, and
nothing important depends on it.

**The trade-off, stated plainly.** This deployment target was chosen so the
thing could be used daily, by its author, at zero marginal cost. What it costs
is control: you cannot pin an exact model version, and you cannot run it without
a Claude account. That is a real limitation, recorded here rather than hidden.

## 5.2 The data model

Three collections:

```
tasks/<id>      { title, day, shape, size, order, status,
                  pushes, createdAt, doneAt, rolledAt }
profile/main    { goals[], habits[], timeZone, rollover }
meta/log        { entries[] }   # ring buffer, last 100
```

`day` is either an ISO date (`2026-09-26`) or the literal `someday`.

There is **no time field anywhere**. As Part 2.2 said, this is the product
thesis enforced by the schema rather than by good intentions.

`order` is an integer position within a day, not a global rank. Two tasks on
different days can both be `0`, because "first" is a claim about a day.

`shape` is what makes energy-aware rescheduling computable rather than
conversational.

`rolledAt` is newer, and exists for one narrow purpose: to ensure an overdue
task cannot be charged more than one push per day no matter how many times the
app is opened. A small field that encodes a fairness rule.

## 5.3 Never trust your inputs

Data arrives from three places that can each be wrong differently: a language
model's JSON, a document store written by an older version of the code, and an
imported backup file a user may have edited by hand.

So no field is ever used as-is. Each has a coercion that always returns
something valid, and there is exactly one way for a task to enter running state:

```js
export function normalizeTask(raw, options) {
  const today = isIsoDay(opts.today) ? opts.today : null;
  const src = raw && typeof raw === "object" ? raw : {};
  const status = coerceStatus(src.status);
  return {
    id:     String(src.id ?? ""),
    title:  coerceTitle(src.title),        // collapse whitespace, cap at 200
    day:    coerceDay(src.day, today),     // real date, or someday, or today
    shape:  coerceShape(src.shape),        // one of four, else admin
    size:   coerceSize(src.size),          // S/M/L, else M
    order:  coerceOrder(src.order),
    status,
    pushes: coerceCount(src.pushes),       // non-negative integer
    doneAt: status === "done" ? coerceStamp(src.doneAt) : null,
    // ...
  };
}
```

Two habits are visible here and both generalise.

**Coercion, not rejection, for display data.** A task with a broken shape should
not vanish or crash the page; it should render as `admin` and remain visible. A
person can fix what they can see.

**Impossible states made unrepresentable.** Look at `doneAt`: an open task
cannot carry a completion timestamp, because the normaliser clears it. There is
no code path that produces that contradiction, so no later code has to handle
it.

And a specific bug worth showing, because it is the kind that survives review:

```js
export function isIsoDay(value) {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  // The regex alone accepts 2026-13-45 and 2026-02-30. Round-trip the parts
  // through a real date and compare back.
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
      && probe.getUTCMonth() === month - 1
      && probe.getUTCDate() === day;
}
```

`/^\d{4}-\d{2}-\d{2}$/` *looks* like date validation. It accepts the 30th of
February. Every test in the suite for this function is a date that the regex
would have let through.

## 5.4 Detecting avoidance

The push counter — the product's whole point — is three lines:

```js
// A push is a deferral, and only a deferral. Pulling work earlier, or off
// "someday" onto a real day, must never be punished — otherwise the counter
// stops measuring avoidance and starts measuring activity.
const deferred = isAfter(action.day, task.day);
const pushes   = coerceCount(task.pushes) + (deferred ? 1 : 0);
```

All the subtlety is inside `isAfter`, which relies on one ordering decision:

```js
export function compareDays(a, b) {
  if (a === b) return 0;
  if (a === SOMEDAY) return 1;    // someday sorts after every dated day
  if (b === SOMEDAY) return -1;
  return a < b ? -1 : 1;          // ISO dates compare correctly as strings
}
```

Two things fall out of this for free.

ISO dates compare correctly with `<` because the format is
biggest-unit-first and zero-padded. `"2026-09-26" < "2026-10-01"` is true as
plain string comparison. No date parsing, no timezone, no arithmetic.

Sorting `someday` last makes the push rule correct without a special case.
Moving to `someday` is the furthest deferral there is, so it counts. Moving
*from* `someday` to a real day is pulling work in, so it does not. Both fall out
of the ordering.

The tests state these as claims about the product, not about the function:

```js
test("isAfter encodes deferral, which is what the push counter needs", () => {
  assert.equal(isAfter("2026-09-27", "2026-09-26"), true);   // deferral
  assert.equal(isAfter("2026-09-25", "2026-09-26"), false);  // pulling forward
  assert.equal(isAfter(SOMEDAY, "2026-09-26"), true);        // furthest deferral
  assert.equal(isAfter("2026-09-26", SOMEDAY), false);       // pulling off someday
});
```

If someone later "simplifies" this, the tests say what breaks and why it
matters.

## 5.5 Undo

A single turn can produce a dozen writes: four tasks created, a day reordered, a
task moved and a push charged. When that plan is wrong — and a model asked to
reshuffle will sometimes be confidently wrong — there has to be a way back.
Without one, the user's only recourse is to reconstruct the previous order from
memory, by hand, which is a worse job than the one they delegated.

There are two ways to build undo, and the choice matters.

**Inverse operations.** Record each change with its opposite, and replay the
opposites backwards. This is what most people reach for. It is also where undo
implementations go wrong: every operation needs a correct inverse, the inverses
must compose in reverse order, and a single mistake corrupts state *silently* —
you find out weeks later.

**Snapshot and diff.** Before each change, copy the state. To undo, compare
current against the snapshot and generate the writes that close the gap. This is
what Order of Play does.

A snapshot cannot be wrong about what the state was. The cost is memory, and for
a single-user queue of a few hundred tasks that cost is irrelevant. It is a
clean trade: spend something you have plenty of to eliminate a class of bug.

```js
export function planRestore(current, target) {
  // ids in target but not current → create
  // ids in both, fields differing → patch only the changed fields
  // ids in current but not target → delete
  // profile differs → one profile write
}
```

The restore is expressed as the same operation descriptors an agent plan
produces, and handed to the same executor. **There is exactly one code path in
the application that writes.** Agent plans, manual edits, rollover and undo all
go through it. One place where ordering and failure handling must be correct,
rather than four.

## 5.6 Time is the hard part

Every calendar application eventually learns this. Here is the bug that was in
this one.

"Today" was computed from the browser's local date. That is fine until you
travel. Fly from San José to Bangalore and the browser's idea of today jumps
forward. Tasks get filed against the wrong day; work that was due today is
suddenly overdue, or is not yet due when it is.

The fix is to anchor to a **stored home timezone** rather than the device:

```js
export function todayIn(timeZone, now = new Date()) {
  if (typeof timeZone === "string" && timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(now);
      // ...assemble YYYY-MM-DD from the parts
    } catch (err) { /* unknown zone: fall through */ }
  }
  return localDay(now);           // fall back to the device
}
```

Three deliberate choices in a short function.

`formatToParts` rather than a formatted string, because locale formatting varies
and assembling from labelled parts cannot be surprised by it.

An unknown timezone falls back instead of throwing. A stale stored preference —
a zone removed in a platform update — must not be able to break the entire page.

The default is empty, meaning *follow this device*. That is correct for the
majority who never travel, and it is honest: it says nobody has told us
otherwise, rather than guessing.

The test states the case directly:

```js
test("todayIn anchors to a zone instead of the host offset", () => {
  // 04:00 UTC is still the 25th in Los Angeles and already the 26th in Kolkata.
  const moment = new Date("2026-09-26T04:00:00Z");
  assert.equal(todayIn("Asia/Kolkata",       moment), "2026-09-26");
  assert.equal(todayIn("America/Los_Angeles", moment), "2026-09-25");
});
```

A related bug lived in the same area and is worth showing, because it is a
perfect example of a wrong answer that *looks* right. Tasks were bucketed like
this:

```js
// the old code
const slot = t.day === TODAY        ? today
           : t.day === addDays(1)   ? tomorrow
           : t.day === "someday"    ? someday
           :                          later;     // ← everything else
```

Read the last line. A task from *last Tuesday* matches none of the equality
tests, so it falls through to "Later this week" — and is displayed as upcoming.
Nothing in the interface ever said a day had passed.

For a deferral tracker, this is close to the worst possible bug: the tasks most
likely to be avoided were the ones most likely to be hidden. The fix is an
explicit Overdue section, an explicit roll-forward, and a test that pins it:

```js
test("overdue work lands in Overdue, not in Later", () => {
  // ...
  assert.deepEqual(group(groups, GROUP_LATER).items.map(t => t.id), ["future"],
    "Later holds only genuinely future work — this is the bug that was fixed");
});
```

The general lesson: **a chain of equality tests with a catch-all `else` is a
place to look for bugs.** The catch-all silently absorbs every case nobody
thought about.

## 5.7 Reading a reply that is not quite JSON

The prompt asks for raw JSON and nothing else. That instruction is followed most
of the time, and *most of the time* is not a contract. Replies arrive fenced in
markdown, prefixed with a sentence of agreement, occasionally with a trailing
"anything else?".

A parser that accepts only the specified format turns each of those into a
failed turn and a lost plan. So the reader is **tolerant about framing and
strict about content**: three attempts to locate the JSON, cheapest first.

```js
export function parseLoose(raw) {
  try { return JSON.parse(text); } catch (err) {}          // 1. the whole thing

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (err) {} }

  const start = text.search(/[{[]/);                        // 3. outermost span
  const end   = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (err) {}
  }
  return null;                                              // never throws
}
```

Then, having found something, it stops being accommodating. If `actions` is a
string rather than an array, that is an error — not something to be helpfully
coerced into a single-element array. Guessing at intent is how bad data gets
written.

The distinction is worth naming, because it is a good general rule:
**be liberal about how the message is wrapped, strict about what it says.**

## 5.8 Failing well

Every failure maps to a stable error code and specific copy. Nothing retries
automatically.

| Code | Response |
| --- | --- |
| `not_granted` | Explain, stop asking |
| `rate_limited` | Say so; never loop |
| `session_expired` | Ask for re-sign-in |
| `refused` | Clear partial output |
| `cancelled` | Silent — the user did it on purpose |
| `prompt_too_large` | Suggest what to prune, specifically |
| parse failure | "I garbled that one. Say it again?" |

Three rules hold here.

**Branch on codes, never on message text.** Message text is copy; it changes.
Code that matches on `/rate limit/` breaks the day someone rewords an error.

**Never retry automatically on `rate_limited`.** An automatic retry burns
exactly the budget that triggered the error. The retry decision belongs to the
person, not the page.

**Do not leak internal strings.** An unmapped code produces generic copy, not
whatever the host happened to say.

And a small detail with teeth:

```js
export function errorCopy(code) {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_COPY, code))
    return ERROR_COPY[code];
  return "Something went wrong reaching Claude. Try again.";
}
```

`hasOwnProperty` rather than a plain lookup, because `ERROR_COPY["toString"]`
would otherwise return a JavaScript function and the interface would render
something absurd. There is a test for exactly that.

## 5.9 How you test an agent

The obvious objection: the model is non-deterministic, so how can any of this be
tested?

By testing everything except the model. Which turns out to be almost all of it.

**What is not tested:** whether Claude gives good advice. That is not a unit
test, it is an evaluation problem, and it belongs in a different kind of harness.

**What is tested — 161 assertions:**

- *Every coercion*, with hostile input. `2026-02-30`. Negative push counts.
  Objects where strings belong. `__proto__` as a shape.
- *Every action*, valid and invalid. The tests are written as claims about
  behaviour, not about implementation: `"order cannot smuggle a task onto
  another day"`, `"a duplicate habit is refused rather than appended"`.
- *The push rule*, in all four directions.
- *Rollover fairness*: a week away costs one push, not seven.
- *Undo and redo*, including that recording a new change clears the redo branch.
- *The parser*, against fenced, prose-wrapped, truncated and malformed replies.
- *Backup round-trips*, including files with deliberately corrupt rows.
- *The prompt itself* — including a test that the worked example shown to the
  model parses with this project's own parser, so the instructions cannot drift
  from the code that reads them.

The trick that makes the action layer testable at all is that planning is
**pure**: it performs no input or output, reads no clock, and generates no
randomness. Everything variable is injected:

```js
function ctx(over) {
  return Object.assign({
    today: "2026-09-26",
    now:   "2026-09-26T10:00:00.000Z",
    makeId: sequentialIdFactory("n")     // deterministic ids
  }, over);
}
```

With time and identity injected, the same input always produces the same plan,
and a plan is an ordinary data structure you can assert on. **Push the
non-determinism to the edges and the middle becomes testable** — which is a good
rule for far more than agents.

Beyond the unit tests, 35 browser checks drive the built artifact in a real
browser: degraded mode with no capabilities at all, the full agent path with a
scripted model reply (deliberately fenced, with prose around it, and carrying
one bogus action), inline editing, rollover, undo, settings, and mobile layout.
Those verify the thing users actually load, not just the functions it contains.

## 5.10 One file, many modules

There is a tension in this project. The deployment target is a single HTML file.
But domain logic trapped inside a single HTML file cannot be tested, which meant
that the action layer — the part the documentation calls the core safety
property — was never exercised by anything.

The resolution: write real modules, and bundle them.

```
src/core/*.js      real ES modules; the tests import these directly
src/shell.html     the interface, with a /*__CORE__*/ marker
build.mjs          sorts by import graph, strips module syntax, inlines
dist/order-of-play.html    ← the single file you publish, committed
```

The important property is that **the tests exercise exactly the source the
bundler inlines.** There is no second copy of the logic to drift out of sync.

The bundler is deliberately dull, and fails loudly rather than producing
something subtly broken. It refuses `export default`, refuses imports that are
not siblings, detects import cycles, and — because bundled modules end up
sharing one scope — refuses two modules that declare the same top-level name:

```
build: task.js redeclares "coerceDay", already declared in day.js.
Core modules share one scope after bundling, so top-level names must be unique.
```

It uses only Node builtins. The project has **zero npm dependencies**, the test
runner is `node:test`, and CI asserts that this stays true — no lockfile, no
entries in `dependencies` or `devDependencies`. CI also runs `build.mjs --check`,
which rebuilds and compares against the committed `dist/`, so a change to a core
module that was never rebuilt fails the build rather than shipping a stale
artifact.

There is even a test that catches a call to a core function that does not exist,
by cross-referencing every identifier the shell calls against the core's actual
exports. It was verified by deliberately introducing a typo and confirming the
test caught it — because a test you have never seen fail is a test you do not
know works.

---
---

# Part 6 — Honest limitations

These are design consequences, not bugs, and they are listed because a project
that hides its trade-offs is harder to trust than one that names them.

**No proactive notifications.** The agent acts when you open it. It cannot wake
you at 8am. Scheduled execution would require a scheduling layer the artifact
runtime does not offer.

**Storage is last-writer-wins.** No transactions, no rollback at the storage
level. Fine for a single-user queue; wrong for anything with real contention.
Undo is application-level, not a database feature.

**Model tier, not model identity.** You choose "quick" or "standard". You cannot
pin an exact model version, so a platform-side change can alter behaviour
without any change to this code.

**Habit learning is append-only.** Observations accumulate but are never revised
or contradicted. A wrong inference — *works best late at night*, recorded during
one unusual fortnight — persists until manually cleared. Genuine habit
consolidation would need a periodic review pass that can retire stale beliefs.
This is the most interesting unfinished part of the project.

**One user.** The whole design assumes a single person's queue. Shared state,
permissions and concurrency are all absent.

**Rollover charges a push for a day passing.** This is a judgement call, and a
defensible person could disagree: you might have been ill, or on holiday. The
mitigations are that it never happens silently and never charges more than once
a day — but it is a choice, not an obvious truth.

---
---

# Part 7 — What would change at scale

| Constraint | Current approach | What multi-user would need |
| --- | --- | --- |
| Concurrency | Last-writer-wins | Transactions or per-day leases |
| Context size | Whole task list in every prompt | Retrieval over a task index |
| Habit quality | Append-only list | Consolidation pass; contradiction handling |
| Model control | Tier selector | Direct API, pinned model and effort |
| Scheduling | User-initiated only | A scheduler or server cron |
| Audit | 100-event ring buffer | Durable append-only log |
| Undo | In-memory, per session | Persisted, server-side history |

The context row is the one that bites first. Today every open task goes into
every prompt, which is correct and cheap at a few hundred tasks. At ten thousand
it exceeds the context window, and the design has to change shape: retrieve the
relevant subset rather than sending everything. That is a genuinely different
architecture, and pretending otherwise would be dishonest.

The single-user, zero-cost constraint is what makes the current design *correct
for its actual purpose*. None of the above is hidden work. Each is a deliberate
trade, recorded here.

---
---

# Part 8 — The code, file by file

```
.
├── README.md                    what it is
├── ARCHITECTURE.md              design notes for engineers
├── CHANGELOG.md                 what changed and when
├── docs/
│   └── UNDERSTANDING-ORDER-OF-PLAY.md     this document
├── package.json                 scripts only; zero dependencies
├── build.mjs                    the bundler
├── .github/workflows/ci.yml     tests on Node 20 and 22
├── src/
│   ├── core/                    pure domain logic — no DOM, no IO
│   │   ├── day.js               calendar-day arithmetic and timezones
│   │   ├── task.js              the schema, coercions, day grouping
│   │   ├── actions.js           the action whitelist — the safety boundary
│   │   ├── rollover.js          overdue work and the fairness rule
│   │   ├── history.js           undo/redo by snapshot and diff
│   │   ├── backup.js            versioned export and import
│   │   ├── parse.js             tolerant reply reading, error copy
│   │   ├── prompt.js            prompt assembly and size budgeting
│   │   └── settings.js          home timezone, rollover policy
│   └── shell.html               interface and wiring
├── dist/
│   └── order-of-play.html       ← publish this one file
└── test/                        161 assertions, node:test, zero deps
```

**Where to start reading**, depending on what you want:

- *The safety argument* → `src/core/actions.js`, then `test/actions.test.js`.
  Read the tests first; they are written as sentences about behaviour.
- *The product idea* → `src/core/prompt.js`. The behavioural rules are the
  product.
- *The subtle bug* → `src/core/day.js` and `groupTasks` in `task.js`.
- *The interface* → `src/shell.html`.

Running it locally:

```bash
node build.mjs      # rebuild dist/ from src/
npm test            # 161 assertions
npm run verify      # check dist/ is current, then test
```

To run the agent itself you publish `dist/order-of-play.html` as a Claude
Artifact with these capabilities declared:

```json
{ "db": {}, "sample": {} }
```

Opening the file directly in a browser renders the full interface with the
agent features inert, because `window.claude` does not exist there. That is the
degradation ladder from Part 5.1 working as designed — and it is how the
screenshots are taken.

---
---

# Part 9 — Glossary

**Action** — One proposed change, as a small JSON object the model returns.
Seven kinds exist; anything else is refused.

**Agent** — A program that gathers context, asks a model what to do, and then
*does* it, changing real state. Distinguished from a chatbot by that last part.

**Artifact** — A single HTML page published to claude.ai, which the host can
grant runtime capabilities such as storage or a model call.

**Capability** — A power the host grants a page at runtime: here, `db` for
storage and `sample` for a model call. May be absent; the page must cope.

**Coercion** — Converting untrusted input into something valid, rather than
rejecting it. A broken shape becomes `admin` instead of crashing the page.

**Context window** — The maximum amount of text a model can consider at once,
measured in tokens. Everything the model knows about your situation fits here.

**Degradation** — Continuing to work, with less function, when something is
missing. The opposite of failing outright.

**Deterministic** — Same input, same output, every time. Models are not; the
code around them is deliberately made so.

**Hallucination** — A model producing confident, plausible, false output. Not
deception; a consequence of being trained for plausibility.

**Inference** — One run of a model: text in, text out.

**Language model** — A program trained to predict text, which acquires broad
capability as a side effect of doing that well.

**Parameters** — The numbers inside a model, adjusted during training. Modern
models have billions.

**Prompt** — The complete text given to the model: instructions, context, data
and question, all as one piece of text.

**Pure function** — A function whose output depends only on its inputs, with no
side effects. Easy to test, which is why the domain logic here is written this
way.

**Push** — One deferral of a task to a later day. The project's central measure.

**Ring buffer** — A fixed-size list that drops its oldest entry when full. Used
for the log, so it cannot grow without bound.

**Shape** — What kind of work a task is: deep, admin, errand or social. Enables
energy-aware rescheduling.

**Snapshot** — A complete copy of state at a moment, used here to implement undo.

**Token** — The unit models read and write, roughly a short word or fragment.

**Whitelist** — A closed list of what is permitted, where anything absent is
refused. The opposite of a blacklist, and the right default for safety.

---
---

# Part 10 — Where to learn more

If this made you want to build one, here is the honest path.

**Start by building the smallest possible agent.** Something that takes one
sentence, calls a model once, and changes one piece of state. Resist the urge to
build a multi-agent system. Almost every problem people solve with a swarm of
agents is better solved by one good prompt and a solid action layer.

**The skills that actually matter** are less exotic than the field's vocabulary
suggests:

1. *Designing the perception step.* What goes in the prompt, what stays out, and
   how it is formatted. This is where most of the quality lives. Giving the model
   a pre-computed conclusion beats giving it raw data and hoping.
2. *Designing the action layer.* A small closed set of operations, each
   validated. If you learn one thing from this document, learn that the model
   proposes and the program disposes.
3. *Handling failure.* Assume malformed output as the normal case.
4. *Managing memory.* What persists, for how long, and what gets reloaded into
   each prompt.

**The mental shift** that takes longest: stop thinking of model output as a
command from a trusted source, and start thinking of it as a form submission
from the open internet. Useful, usually well-intentioned, always validated. Once
that becomes instinct, agent design stops feeling mysterious and starts feeling
like ordinary careful engineering — which is what it is.

**On this project specifically:** [ARCHITECTURE.md](../ARCHITECTURE.md) has the
design notes at an engineer's level of detail, [README.md](../README.md) is the
short version, and the test suite is genuinely the best documentation of
intended behaviour, because each test is a sentence about what the product
should do.

---

*Order of Play is MIT licensed. The code is in this repository; the reasoning is
in this document.*
