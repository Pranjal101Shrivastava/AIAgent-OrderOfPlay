import test from "node:test";
import assert from "node:assert/strict";

import { SOMEDAY } from "../src/core/day.js";
import { normalizeTask } from "../src/core/task.js";
import { PUSH_ALARM } from "../src/core/actions.js";
import { readAgentReply } from "../src/core/parse.js";
import { HISTORY_LINES, PROMPT_BUDGET, buildPrompt, promptFits, trimAdvice } from "../src/core/prompt.js";

const TODAY = "2026-09-26";

function tasks(rows) {
  return rows.map((r) => normalizeTask(r, { today: TODAY }));
}

test("the prompt carries today and tomorrow", () => {
  const out = buildPrompt({ message: "hi", today: TODAY, tasks: [], profile: {}, log: [] });
  assert.match(out, /TODAY IS 2026-09-26/);
  assert.match(out, /Tomorrow is 2026-09-27/);
});

test("every open task appears with its id", () => {
  const out = buildPrompt({
    message: "arrange these",
    today: TODAY,
    tasks: tasks([
      { id: "a1", title: "Write it", day: TODAY, shape: "deep", size: "L", pushes: 2 },
      { id: "finished", title: "Done thing", day: TODAY, status: "done" }
    ]),
    profile: {},
    log: []
  });
  assert.match(out, /id=a1 \| "Write it" \| day=2026-09-26 \| shape=deep \| size=L/);
  assert.match(out, /pushed=2x/);
  const section = out.slice(out.indexOf("ALL OPEN TASKS"), out.indexOf("CHRONICALLY AVOIDED"));
  assert.equal(
    /finished/.test(section),
    false,
    "completed work is not context the model needs"
  );
});

test("overdue work gets its own labelled section", () => {
  const out = buildPrompt({
    message: "what now",
    today: TODAY,
    tasks: tasks([{ id: "late", title: "The paper", day: "2026-09-20" }]),
    profile: {},
    log: []
  });
  assert.match(out, /OVERDUE/);
  assert.match(out, /id=late \| "The paper" \| was due 2026-09-20/);
  assert.match(out, /Work listed as OVERDUE/, "and a rule telling the model to act on it");
});

test("an empty queue says so rather than leaving a blank", () => {
  const out = buildPrompt({ message: "hi", today: TODAY, tasks: [], profile: {}, log: [] });
  assert.match(out, /ALL OPEN TASKS\n\(none\)/);
  assert.match(out, /OVERDUE[^\n]*\n\(none\)/);
  assert.match(out, /\(none recorded yet\)/);
  assert.match(out, /\(nothing yet\)/);
});

test("chronically pushed tasks are called out separately", () => {
  const out = buildPrompt({
    message: "plan my day",
    today: TODAY,
    tasks: tasks([
      { id: "stuck", title: "The thing", day: TODAY, pushes: PUSH_ALARM },
      { id: "fine", title: "Easy", day: TODAY, pushes: 0 }
    ]),
    profile: {},
    log: []
  });
  assert.match(out, /CHRONICALLY AVOIDED[\s\S]*id=stuck/);
  const section = out.slice(out.indexOf("CHRONICALLY AVOIDED"), out.indexOf("RECENT HISTORY"));
  assert.equal(/fine/.test(section), false);
});

test("goals and habits are included when present", () => {
  const out = buildPrompt({
    message: "hi",
    today: TODAY,
    tasks: [],
    profile: { goals: ["finish the thesis"], habits: ["works best after 10pm"] },
    log: []
  });
  assert.match(out, /- finish the thesis/);
  assert.match(out, /- works best after 10pm/);
});

test("history is trimmed to the documented window", () => {
  const log = Array.from({ length: 40 }, (_, i) => ({
    ts: "2026-09-2" + (i % 9) + "T10:00:00Z",
    text: `event ${i}`
  }));
  const out = buildPrompt({ message: "hi", today: TODAY, tasks: [], profile: {}, log });
  assert.match(out, /event 39/);
  assert.equal(/event 0\b/.test(out), false);
  const lines = out.slice(out.indexOf("RECENT HISTORY")).split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, HISTORY_LINES);
});

test("the prompt states the output contract the parser implements", () => {
  const out = buildPrompt({ message: "hi", today: TODAY, tasks: [], profile: {}, log: [] });
  assert.match(out, /Reply with ONLY a JSON object/);
  assert.match(out, /no markdown code fences/);
  ["add", "order", "move", "done", "drop", "habit", "goal"].forEach((op) => {
    assert.ok(out.includes(`"op":"${op}"`), `the ${op} op is documented to the model`);
  });
});

test("the worked example in the prompt parses with the real parser", () => {
  const out = buildPrompt({ message: "hi", today: TODAY, tasks: [], profile: {}, log: [] });
  const example = out.slice(out.lastIndexOf("Example: ") + "Example: ".length).trim();
  const parsed = readAgentReply(example);
  assert.equal(parsed.ok, true, "the example we show the model must satisfy our own parser");
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.actions[0].op, "move");
});

test("the name is used, with a neutral fallback", () => {
  const named = buildPrompt({ message: "hi", today: TODAY, tasks: [], profile: {}, log: [], name: "Pranjal" });
  assert.match(named, /You are Pranjal's personal secretary/);
  const anon = buildPrompt({ message: "hi", today: TODAY, tasks: [], profile: {}, log: [] });
  assert.match(anon, /You are the user's personal secretary/);
  assert.match(anon, /Days are fixed; hours are theirs/, "copy stays grammatical without a name");
});

test("the user's message is included verbatim", () => {
  const message = "I'm sleepy, not starting the write-up";
  const out = buildPrompt({ message, today: TODAY, tasks: [], profile: {}, log: [] });
  assert.ok(out.includes(message));
});

test("promptFits measures bytes, not characters", () => {
  const ascii = promptFits("abc", 10);
  assert.deepEqual([ascii.bytes, ascii.fits], [3, true]);
  const wide = promptFits("日本語", 5);
  assert.equal(wide.bytes, 9, "three characters, nine bytes");
  assert.equal(wide.fits, false, "a character count would have wrongly passed this");
});

test("a realistic queue fits the budget comfortably", () => {
  const many = tasks(
    Array.from({ length: 120 }, (_, i) => ({
      id: `t${i}`,
      title: `Task number ${i} with a reasonably descriptive title`,
      day: TODAY
    }))
  );
  const out = buildPrompt({ message: "plan it", today: TODAY, tasks: many, profile: {}, log: [] });
  assert.equal(promptFits(out).fits, true);
  assert.equal(promptFits(out).cap, PROMPT_BUDGET);
});

test("trimAdvice points at the biggest thing to prune", () => {
  const done = tasks(Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, status: "done" })));
  assert.match(trimAdvice(done), /30 completed tasks/);
  const someday = tasks(Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, day: SOMEDAY })));
  assert.match(trimAdvice(someday), /Someday list has 50/);
  assert.match(trimAdvice([]), /clear some finished tasks/);
});
