import test from "node:test";
import assert from "node:assert/strict";

import { SOMEDAY } from "../src/core/day.js";
import { normalizeTask } from "../src/core/task.js";
import {
  AGENT_OPS,
  MAX_ACTIONS,
  MAX_GOALS,
  MAX_HABITS,
  PUSH_ALARM,
  describeRejections,
  planActions,
  sequentialIdFactory
} from "../src/core/actions.js";

const TODAY = "2026-09-26";
const TOMORROW = "2026-09-27";
const NOW = "2026-09-26T10:00:00.000Z";

function ctx(over) {
  return Object.assign({ today: TODAY, now: NOW, makeId: sequentialIdFactory("n") }, over);
}

function state(tasks, profile) {
  return {
    tasks: (tasks || []).map((t) => normalizeTask(t, { today: TODAY })),
    profile: profile || { goals: [], habits: [] }
  };
}

function opsOfKind(result, kind) {
  return result.ops.filter((o) => o.kind === kind);
}

// --- the whitelist ---------------------------------------------------------

test("an unknown op is refused by name and writes nothing", () => {
  const result = planActions(
    [{ op: "deleteEverything" }, { op: "eval", code: "1" }, { op: "" }],
    state([]),
    ctx()
  );
  assert.deepEqual(result.ops, [], "no writes escape from unknown ops");
  assert.equal(result.rejected.length, 3);
  assert.match(result.rejected[0].reason, /unknown op/);
});

test("the op whitelist is exactly the documented seven", () => {
  assert.deepEqual(AGENT_OPS, ["add", "order", "move", "done", "drop", "habit", "goal"]);
});

test("prototype-polluting op names do not dispatch", () => {
  const result = planActions(
    [{ op: "__proto__" }, { op: "constructor" }, { op: "toString" }, { op: "hasOwnProperty" }],
    state([]),
    ctx()
  );
  assert.deepEqual(result.ops, []);
  assert.equal(result.rejected.length, 4);
});

test("non-objects in the action list are refused", () => {
  const result = planActions(["add", 42, null, [], true], state([]), ctx());
  assert.deepEqual(result.ops, []);
  assert.equal(result.rejected.length, 5);
});

test("a non-array actions value is refused without throwing", () => {
  assert.deepEqual(planActions("add a task", state([]), ctx()).ops, []);
  assert.deepEqual(planActions({ op: "add" }, state([]), ctx()).ops, []);
  assert.deepEqual(planActions(undefined, state([]), ctx()).rejected, [], "absent is not an error");
  assert.equal(planActions(null, state([]), ctx()).rejected.length, 0);
});

test("the batch is capped and the overflow is reported", () => {
  const many = Array.from({ length: MAX_ACTIONS + 5 }, (_, i) => ({
    op: "add",
    title: `task ${i}`,
    day: TODAY
  }));
  const result = planActions(many, state([]), ctx());
  assert.equal(opsOfKind(result, "create").length, MAX_ACTIONS);
  assert.ok(
    result.rejected.some((r) => /capped at 40/.test(r.reason)),
    "the user is told the batch was truncated"
  );
});

// --- add -------------------------------------------------------------------

test("add builds a validated task with a client id", () => {
  const result = planActions(
    [{ op: "add", title: "  Write the eval  ", day: TODAY, shape: "deep", size: "L" }],
    state([]),
    ctx()
  );
  const created = opsOfKind(result, "create");
  assert.equal(created.length, 1);
  assert.equal(created[0].task.title, "Write the eval");
  assert.equal(created[0].task.shape, "deep");
  assert.equal(created[0].task.size, "L");
  assert.equal(created[0].task.day, TODAY);
  assert.equal(created[0].task.order, 0);
  assert.equal(created[0].task.pushes, 0);
  assert.equal(created[0].task.createdAt, NOW);
  assert.equal(created[0].id, "n1", "ids come from the injected factory");
});

test("add without a title is refused", () => {
  const result = planActions([{ op: "add", day: TODAY }, { op: "add", title: "  " }], state([]), ctx());
  assert.deepEqual(result.ops, []);
  assert.equal(result.rejected.length, 2);
});

test("add repairs a bad day, shape and size, and says it did", () => {
  const result = planActions(
    [{ op: "add", title: "x", day: "2026-02-30", shape: "urgent", size: "XL" }],
    state([]),
    ctx()
  );
  const task = opsOfKind(result, "create")[0].task;
  assert.equal(task.day, TODAY);
  assert.equal(task.shape, "admin");
  assert.equal(task.size, "M");
  assert.equal(result.rejected.length, 3, "each repair is surfaced, not silent");
});

test("several adds to one day take consecutive order slots", () => {
  const result = planActions(
    [
      { op: "add", title: "a", day: TODAY },
      { op: "add", title: "b", day: TODAY },
      { op: "add", title: "c", day: TOMORROW }
    ],
    state([{ id: "e", day: TODAY, order: 0 }]),
    ctx()
  );
  const created = opsOfKind(result, "create");
  assert.deepEqual(created.map((o) => o.task.order), [1, 2, 0]);
});

// --- order -----------------------------------------------------------------

test("order rewrites indices for the listed day", () => {
  const result = planActions(
    [{ op: "order", day: TODAY, ids: ["c", "a", "b"] }],
    state([
      { id: "a", day: TODAY, order: 0 },
      { id: "b", day: TODAY, order: 1 },
      { id: "c", day: TODAY, order: 2 }
    ]),
    ctx()
  );
  const patches = opsOfKind(result, "patch");
  assert.deepEqual(
    patches.map((p) => [p.id, p.fields.order]),
    [["c", 0], ["a", 1], ["b", 2]]
  );
});

test("order cannot smuggle a task onto another day", () => {
  const result = planActions(
    [{ op: "order", day: TODAY, ids: ["a", "elsewhere"] }],
    state([
      { id: "a", day: TODAY, order: 0 },
      { id: "elsewhere", day: TOMORROW, order: 0 }
    ]),
    ctx()
  );
  assert.deepEqual(
    opsOfKind(result, "patch").map((p) => p.id),
    [],
    "nothing moved and nothing reordered"
  );
  assert.ok(result.rejected.some((r) => /not an open task on/.test(r.reason)));
  assert.equal(
    result.tasks.find((t) => t.id === "elsewhere").day,
    TOMORROW,
    "the outsider keeps its day"
  );
});

test("order tolerates a forgotten task by appending it after the listed ones", () => {
  const result = planActions(
    [{ op: "order", day: TODAY, ids: ["b"] }],
    state([
      { id: "a", day: TODAY, order: 0 },
      { id: "b", day: TODAY, order: 1 }
    ]),
    ctx()
  );
  const byId = {};
  opsOfKind(result, "patch").forEach((p) => {
    byId[p.id] = p.fields.order;
  });
  assert.equal(byId.b, 0);
  assert.equal(byId.a, 1, "the unlisted task follows rather than colliding at 0");
});

test("order rejects a duplicated id", () => {
  const result = planActions(
    [{ op: "order", day: TODAY, ids: ["a", "a"] }],
    state([{ id: "a", day: TODAY, order: 0 }]),
    ctx()
  );
  assert.ok(result.rejected.some((r) => /listed twice/.test(r.reason)));
});

test("order refuses a bad day or a missing ids array", () => {
  const s = state([{ id: "a", day: TODAY }]);
  assert.equal(planActions([{ op: "order", day: "nope", ids: ["a"] }], s, ctx()).ops.length, 0);
  assert.equal(planActions([{ op: "order", day: TODAY }], s, ctx()).ops.length, 0);
  assert.equal(planActions([{ op: "order", day: TODAY, ids: "a" }], s, ctx()).ops.length, 0);
});

test("order emits no write when the sequence is already correct", () => {
  const result = planActions(
    [{ op: "order", day: TODAY, ids: ["a", "b"] }],
    state([
      { id: "a", day: TODAY, order: 0 },
      { id: "b", day: TODAY, order: 1 }
    ]),
    ctx()
  );
  assert.deepEqual(opsOfKind(result, "patch"), [], "a no-op reorder costs nothing");
});

test("an add and an order in one batch cooperate", () => {
  const result = planActions(
    [
      { op: "add", title: "fresh", day: TODAY },
      { op: "order", day: TODAY, ids: ["n1", "a"] }
    ],
    state([{ id: "a", day: TODAY, order: 0 }]),
    ctx()
  );
  assert.equal(opsOfKind(result, "create").length, 1);
  const orders = opsOfKind(result, "patch").filter((p) => "order" in p.fields);
  assert.ok(
    orders.some((p) => p.id === "a" && p.fields.order === 1),
    "the new task can be referenced by the same batch that created it"
  );
});

// --- move and the push counter --------------------------------------------

test("moving to a later day counts a push", () => {
  const result = planActions(
    [{ op: "move", id: "a", day: TOMORROW }],
    state([{ id: "a", day: TODAY, pushes: 1 }]),
    ctx()
  );
  const patch = opsOfKind(result, "patch")[0];
  assert.equal(patch.fields.day, TOMORROW);
  assert.equal(patch.fields.pushes, 2);
  assert.match(result.log[0], /push 2/);
});

test("moving to an earlier day does not count a push", () => {
  const result = planActions(
    [{ op: "move", id: "a", day: TODAY }],
    state([{ id: "a", day: "2026-10-10", pushes: 2 }]),
    ctx()
  );
  const patch = opsOfKind(result, "patch")[0];
  assert.equal(patch.fields.pushes, 2, "pulling work forward is not avoidance");
});

test("someday is the furthest deferral, and coming back from it is free", () => {
  const deferred = planActions(
    [{ op: "move", id: "a", day: SOMEDAY }],
    state([{ id: "a", day: "2099-12-31", pushes: 0 }]),
    ctx()
  );
  assert.equal(opsOfKind(deferred, "patch")[0].fields.pushes, 1);

  const pulled = planActions(
    [{ op: "move", id: "a", day: TODAY }],
    state([{ id: "a", day: SOMEDAY, pushes: 3 }]),
    ctx()
  );
  assert.equal(opsOfKind(pulled, "patch")[0].fields.pushes, 3);
});

test("a push reaching the alarm threshold is reported to the caller", () => {
  const result = planActions(
    [{ op: "move", id: "a", day: TOMORROW }],
    state([{ id: "a", title: "The paper", day: TODAY, pushes: PUSH_ALARM - 1 }]),
    ctx()
  );
  assert.deepEqual(result.alarms, [{ id: "a", title: "The paper", pushes: PUSH_ALARM }]);
});

test("a move below the threshold raises no alarm", () => {
  const result = planActions(
    [{ op: "move", id: "a", day: TOMORROW }],
    state([{ id: "a", day: TODAY, pushes: 0 }]),
    ctx()
  );
  assert.deepEqual(result.alarms, []);
});

test("move places the task at the end of its new day", () => {
  const result = planActions(
    [{ op: "move", id: "a", day: TOMORROW }],
    state([
      { id: "a", day: TODAY, order: 0 },
      { id: "x", day: TOMORROW, order: 0 },
      { id: "y", day: TOMORROW, order: 1 }
    ]),
    ctx()
  );
  assert.equal(opsOfKind(result, "patch")[0].fields.order, 2);
});

test("move refuses unknown ids, bad days and pointless moves", () => {
  const s = state([{ id: "a", day: TODAY }]);
  assert.equal(planActions([{ op: "move", id: "ghost", day: TOMORROW }], s, ctx()).ops.length, 0);
  assert.equal(planActions([{ op: "move", id: "a", day: "nope" }], s, ctx()).ops.length, 0);
  const same = planActions([{ op: "move", id: "a", day: TODAY }], s, ctx());
  assert.equal(same.ops.length, 0);
  assert.match(same.rejected[0].reason, /already on/);
});

test("two moves of the same task in one batch accumulate correctly", () => {
  const result = planActions(
    [
      { op: "move", id: "a", day: TOMORROW },
      { op: "move", id: "a", day: "2026-09-30" }
    ],
    state([{ id: "a", day: TODAY, pushes: 0 }]),
    ctx()
  );
  const patches = opsOfKind(result, "patch");
  assert.equal(patches.length, 2);
  assert.equal(patches[1].fields.pushes, 2, "the working copy carries the first push forward");
});

// --- done and drop --------------------------------------------------------

test("done stamps the completion time", () => {
  const result = planActions([{ op: "done", id: "a" }], state([{ id: "a", day: TODAY }]), ctx());
  assert.deepEqual(opsOfKind(result, "patch")[0].fields, { status: "done", doneAt: NOW });
});

test("done on an already-finished task is refused", () => {
  const result = planActions(
    [{ op: "done", id: "a" }],
    state([{ id: "a", day: TODAY, status: "done", doneAt: NOW }]),
    ctx()
  );
  assert.equal(result.ops.length, 0);
  assert.match(result.rejected[0].reason, /already done/);
});

test("drop deletes and removes the task from the working copy", () => {
  const result = planActions(
    [{ op: "drop", id: "a" }, { op: "done", id: "a" }],
    state([{ id: "a", day: TODAY }]),
    ctx()
  );
  assert.deepEqual(opsOfKind(result, "delete"), [{ kind: "delete", id: "a" }]);
  assert.equal(
    result.rejected.length,
    1,
    "the follow-up done cannot act on what the batch just deleted"
  );
});

// --- profile --------------------------------------------------------------

test("habit and goal fold into one profile write", () => {
  const result = planActions(
    [
      { op: "habit", text: "works best late at night" },
      { op: "goal", text: "ship the thesis draft" }
    ],
    state([]),
    ctx()
  );
  const profiles = opsOfKind(result, "profile");
  assert.equal(profiles.length, 1, "one document, one write");
  assert.deepEqual(profiles[0].profile.habits, ["works best late at night"]);
  assert.deepEqual(profiles[0].profile.goals, ["ship the thesis draft"]);
});

test("a duplicate habit is refused rather than appended", () => {
  const result = planActions(
    [{ op: "habit", text: "works late" }],
    state([], { goals: [], habits: ["works late"] }),
    ctx()
  );
  assert.equal(opsOfKind(result, "profile").length, 0);
  assert.match(result.rejected[0].reason, /already recorded/);
});

test("habit text is normalised before the duplicate check", () => {
  const result = planActions(
    [{ op: "habit", text: "  works   late  " }],
    state([], { goals: [], habits: ["works late"] }),
    ctx()
  );
  assert.equal(opsOfKind(result, "profile").length, 0, "whitespace is not a new habit");
});

test("habits and goals are capped, keeping the most recent", () => {
  const habits = Array.from({ length: MAX_HABITS }, (_, i) => `habit ${i}`);
  const result = planActions([{ op: "habit", text: "the newest" }], state([], { goals: [], habits }), ctx());
  const stored = opsOfKind(result, "profile")[0].profile.habits;
  assert.equal(stored.length, MAX_HABITS);
  assert.equal(stored[stored.length - 1], "the newest");
  assert.equal(stored.indexOf("habit 0"), -1, "the oldest is evicted");

  const goals = Array.from({ length: MAX_GOALS }, (_, i) => `goal ${i}`);
  const g = planActions([{ op: "goal", text: "new goal" }], state([], { goals, habits: [] }), ctx());
  assert.equal(opsOfKind(g, "profile")[0].profile.goals.length, MAX_GOALS);
});

test("habit and goal without text are refused", () => {
  const result = planActions([{ op: "habit" }, { op: "goal", text: "   " }], state([]), ctx());
  assert.equal(result.ops.length, 0);
  assert.equal(result.rejected.length, 2);
});

test("planning does not mutate the state it was given", () => {
  const original = state([{ id: "a", day: TODAY, order: 0, pushes: 0 }], { goals: [], habits: [] });
  const frozenDay = original.tasks[0].day;
  planActions(
    [{ op: "move", id: "a", day: TOMORROW }, { op: "habit", text: "x" }],
    original,
    ctx()
  );
  assert.equal(original.tasks[0].day, frozenDay, "the caller's tasks are untouched");
  assert.deepEqual(original.profile.habits, [], "the caller's profile is untouched");
});

test("describeRejections reads as a sentence", () => {
  assert.equal(describeRejections([]), "");
  assert.equal(describeRejections(null), "");
  assert.match(describeRejections([{ reason: "unknown op \"x\"" }]), /^Ignored one instruction/);
  assert.match(describeRejections([{ reason: "a" }, { reason: "b" }]), /^Ignored 2 instructions/);
});

test("a realistic mixed batch produces a coherent plan", () => {
  const result = planActions(
    [
      { op: "add", title: "Draft the abstract", day: TODAY, shape: "deep", size: "L" },
      { op: "move", id: "paper", day: TOMORROW },
      { op: "done", id: "emails" },
      { op: "order", day: TODAY, ids: ["n1", "groceries"] },
      { op: "habit", text: "avoids deep work after 6pm" },
      { op: "nonsense", id: "x" }
    ],
    state([
      { id: "paper", title: "The paper", day: TODAY, pushes: 2, order: 0 },
      { id: "emails", title: "Emails", day: TODAY, order: 1 },
      { id: "groceries", title: "Groceries", day: TODAY, order: 2 }
    ]),
    ctx()
  );
  assert.equal(opsOfKind(result, "create").length, 1);
  assert.equal(opsOfKind(result, "profile").length, 1);
  assert.equal(result.rejected.length, 1, "only the bogus op is refused");
  assert.equal(result.alarms.length, 1, "the thrice-pushed paper trips the alarm");
  assert.equal(result.alarms[0].pushes, 3);
  assert.ok(result.log.length >= 4);
});
