import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTask } from "../src/core/task.js";
import { HISTORY_LIMIT, createHistory, planRestore, snapshot } from "../src/core/history.js";

const TODAY = "2026-09-26";

function st(rows, profile) {
  return {
    tasks: (rows || []).map((r) => normalizeTask(r, { today: TODAY })),
    profile: profile || { goals: [], habits: [] }
  };
}

test("snapshot is a structural copy, not a reference", () => {
  const original = st([{ id: "a", title: "One" }], { goals: ["g"], habits: [] });
  const copy = snapshot(original);
  copy.tasks[0].title = "Changed";
  copy.profile.goals.push("another");
  assert.equal(original.tasks[0].title, "One");
  assert.deepEqual(original.profile.goals, ["g"]);
});

test("snapshot tolerates junk", () => {
  assert.deepEqual(snapshot(null), { tasks: [], profile: { goals: [], habits: [] } });
  assert.deepEqual(snapshot({}), { tasks: [], profile: { goals: [], habits: [] } });
  assert.deepEqual(snapshot({ tasks: "x", profile: 5 }).tasks, []);
});

test("planRestore patches only the fields that differ", () => {
  const before = st([{ id: "a", title: "One", day: TODAY, order: 0 }]);
  const after = st([{ id: "a", title: "One", day: "2026-09-27", order: 3 }]);
  const plan = planRestore(after, before);
  assert.equal(plan.ops.length, 1);
  assert.deepEqual(plan.ops[0], { kind: "patch", id: "a", fields: { day: TODAY, order: 0 } });
});

test("planRestore recreates a deleted task and deletes a created one", () => {
  const before = st([{ id: "a" }]);
  const after = st([{ id: "b" }]);
  const plan = planRestore(after, before);
  const kinds = plan.ops.map((o) => `${o.kind}:${o.id}`).sort();
  assert.deepEqual(kinds, ["create:a", "delete:b"]);
});

test("planRestore reverts a profile change", () => {
  const before = st([], { goals: [], habits: [] });
  const after = st([], { goals: [], habits: ["a wrong inference"] });
  const plan = planRestore(after, before);
  assert.equal(plan.ops.length, 1);
  assert.deepEqual(plan.ops[0].profile, { goals: [], habits: [] });
});

test("planRestore of identical states is empty", () => {
  const a = st([{ id: "a", title: "Same" }], { goals: ["g"], habits: ["h"] });
  assert.equal(planRestore(a, st([{ id: "a", title: "Same" }], { goals: ["g"], habits: ["h"] })).changed, 0);
});

test("undo returns the ops that restore the previous state", () => {
  const history = createHistory();
  const before = st([{ id: "a", day: TODAY, order: 0 }]);
  history.record(before, "reshuffle");
  const after = st([{ id: "a", day: "2026-10-01", order: 5 }]);

  const undone = history.undo(after);
  assert.equal(undone.label, "reshuffle");
  assert.deepEqual(undone.ops[0].fields, { day: TODAY, order: 0 });
});

test("undo then redo returns to where it started", () => {
  const history = createHistory();
  const before = st([{ id: "a", title: "Original" }]);
  history.record(before, "rename");
  const after = st([{ id: "a", title: "Renamed" }]);

  const undone = history.undo(after);
  assert.equal(undone.state.tasks[0].title, "Original");
  const redone = history.redo(undone.state);
  assert.equal(redone.state.tasks[0].title, "Renamed");
  assert.equal(history.canRedo, false);
  assert.equal(history.canUndo, true);
});

test("recording a new change clears the redo branch", () => {
  const history = createHistory();
  history.record(st([{ id: "a", title: "v1" }]), "first");
  history.undo(st([{ id: "a", title: "v2" }]));
  assert.equal(history.canRedo, true);
  history.record(st([{ id: "a", title: "v1" }]), "second");
  assert.equal(history.canRedo, false, "a new edit abandons the old future");
});

test("undo and redo are null when there is nothing to do", () => {
  const history = createHistory();
  assert.equal(history.undo(st([])), null);
  assert.equal(history.redo(st([])), null);
  assert.equal(history.canUndo, false);
  assert.equal(history.undoLabel, "");
});

test("the stack is bounded and drops the oldest entry", () => {
  const history = createHistory(3);
  ["a", "b", "c", "d"].forEach((label) => history.record(st([]), label));
  assert.equal(history.depth, 3);
  assert.equal(history.undoLabel, "d", "the newest is on top");
  history.undo(st([]));
  history.undo(st([]));
  history.undo(st([]));
  assert.equal(history.canUndo, false, "only three were retained");
});

test("the default limit is the documented one", () => {
  assert.equal(createHistory().limit, HISTORY_LIMIT);
  assert.equal(createHistory(0).limit, HISTORY_LIMIT, "a nonsense limit falls back");
  assert.equal(createHistory(-4).limit, HISTORY_LIMIT);
});

test("clear empties both directions", () => {
  const history = createHistory();
  history.record(st([]), "x");
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test("a multi-step undo walks back one change at a time", () => {
  const history = createHistory();
  const v1 = st([{ id: "a", title: "v1" }]);
  history.record(v1, "to v2");
  const v2 = st([{ id: "a", title: "v2" }]);
  history.record(v2, "to v3");
  const v3 = st([{ id: "a", title: "v3" }]);

  const first = history.undo(v3);
  assert.equal(first.state.tasks[0].title, "v2");
  const second = history.undo(first.state);
  assert.equal(second.state.tasks[0].title, "v1");
  assert.equal(history.canUndo, false);
});
