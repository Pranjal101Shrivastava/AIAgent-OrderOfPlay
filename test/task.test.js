import test from "node:test";
import assert from "node:assert/strict";

import { SOMEDAY } from "../src/core/day.js";
import {
  GROUP_LATER,
  GROUP_OVERDUE,
  GROUP_SOMEDAY,
  GROUP_TODAY,
  GROUP_TOMORROW,
  TITLE_MAX,
  coerceCount,
  coerceDay,
  coerceShape,
  coerceSize,
  coerceTitle,
  groupTasks,
  isReorderable,
  nextOrder,
  normalizeTask,
  orderedIds,
  planEdit,
  sortByOrder
} from "../src/core/task.js";

const TODAY = "2026-09-26";
const TOMORROW = "2026-09-27";

function task(over) {
  return normalizeTask(Object.assign({ id: "t1", title: "Thing", day: TODAY }, over), {
    today: TODAY
  });
}

function group(groups, kind) {
  return groups.find((g) => g.kind === kind);
}

test("coerceTitle collapses whitespace and never yields empty", () => {
  assert.equal(coerceTitle("  hello   world  "), "hello world");
  assert.equal(coerceTitle(""), "Untitled");
  assert.equal(coerceTitle("   "), "Untitled");
  assert.equal(coerceTitle(null), "Untitled");
  assert.equal(coerceTitle(undefined), "Untitled");
  assert.equal(coerceTitle("a\n\nb\tc"), "a b c");
  assert.equal(coerceTitle(42), "42");
});

test("coerceTitle truncates to the schema limit", () => {
  const long = "x".repeat(TITLE_MAX + 50);
  assert.equal(coerceTitle(long).length, TITLE_MAX);
});

test("coerceShape and coerceSize fall back rather than propagate junk", () => {
  assert.equal(coerceShape("deep"), "deep");
  assert.equal(coerceShape("DEEP"), "admin", "shape is case sensitive");
  assert.equal(coerceShape("urgent"), "admin");
  assert.equal(coerceShape(null), "admin");
  assert.equal(coerceSize("L"), "L");
  assert.equal(coerceSize("l"), "L", "size is forgiving about case");
  assert.equal(coerceSize("XL"), "M");
  assert.equal(coerceSize(5), "M");
});

test("coerceDay prefers the value, then the fallback, then someday", () => {
  assert.equal(coerceDay(TODAY, TODAY), TODAY);
  assert.equal(coerceDay("2026-02-30", TODAY), TODAY, "impossible date uses fallback");
  assert.equal(coerceDay("nonsense", null), SOMEDAY, "no fallback means someday");
  assert.equal(coerceDay(SOMEDAY, TODAY), SOMEDAY);
});

test("coerceCount refuses negatives and nonsense", () => {
  assert.equal(coerceCount(3), 3);
  assert.equal(coerceCount(-5), 0, "a corrupt counter cannot go negative");
  assert.equal(coerceCount("4"), 4);
  assert.equal(coerceCount(2.7), 2);
  assert.equal(coerceCount(NaN), 0);
  assert.equal(coerceCount(Infinity), 0);
  assert.equal(coerceCount(undefined), 0);
});

test("normalizeTask produces a complete task from almost nothing", () => {
  const t = normalizeTask({ id: "x" }, { today: TODAY });
  assert.deepEqual(t, {
    id: "x",
    title: "Untitled",
    day: TODAY,
    shape: "admin",
    size: "M",
    order: 0,
    status: "open",
    pushes: 0,
    createdAt: null,
    doneAt: null,
    rolledAt: null
  });
});

test("normalizeTask clears doneAt on an open task", () => {
  const t = normalizeTask(
    { id: "x", status: "open", doneAt: "2026-09-20T10:00:00Z" },
    { today: TODAY }
  );
  assert.equal(t.doneAt, null, "an open task cannot carry a completion stamp");
});

test("normalizeTask discards unparseable timestamps", () => {
  const t = normalizeTask({ id: "x", status: "done", doneAt: "yesterday" }, { today: TODAY });
  assert.equal(t.doneAt, null);
});

test("normalizeTask survives a hostile document", () => {
  const t = normalizeTask(
    {
      id: { nope: true },
      title: { toString: () => "coerced" },
      day: [],
      shape: "__proto__",
      size: {},
      order: "abc",
      pushes: -9,
      status: "deleted"
    },
    { today: TODAY }
  );
  assert.equal(t.day, TODAY);
  assert.equal(t.shape, "admin");
  assert.equal(t.size, "M");
  assert.equal(t.order, 0);
  assert.equal(t.pushes, 0);
  assert.equal(t.status, "open");
});

test("nextOrder counts only open tasks on that day", () => {
  const tasks = [
    task({ id: "a", day: TODAY }),
    task({ id: "b", day: TODAY, status: "done" }),
    task({ id: "c", day: TOMORROW })
  ];
  assert.equal(nextOrder(tasks, TODAY), 1, "the done task does not hold a slot");
  assert.equal(nextOrder(tasks, TOMORROW), 1);
  assert.equal(nextOrder(tasks, SOMEDAY), 0);
});

test("sortByOrder is stable on ties via id", () => {
  const out = sortByOrder([
    task({ id: "b", order: 1 }),
    task({ id: "a", order: 1 }),
    task({ id: "c", order: 0 })
  ]);
  assert.deepEqual(out.map((t) => t.id), ["c", "a", "b"]);
});

test("orderedIds returns the open queue for one day", () => {
  const tasks = [
    task({ id: "a", day: TODAY, order: 2 }),
    task({ id: "b", day: TODAY, order: 0 }),
    task({ id: "c", day: TODAY, order: 1, status: "done" }),
    task({ id: "d", day: TOMORROW, order: 0 })
  ];
  assert.deepEqual(orderedIds(tasks, TODAY), ["b", "a"]);
});

// --- the regression this version exists to fix -----------------------------

test("overdue work lands in Overdue, not in Later", () => {
  const tasks = [
    task({ id: "old", day: "2026-09-20" }),
    task({ id: "older", day: "2026-09-14" }),
    task({ id: "now", day: TODAY }),
    task({ id: "soon", day: TOMORROW }),
    task({ id: "future", day: "2026-10-05" }),
    task({ id: "maybe", day: SOMEDAY })
  ];
  const groups = groupTasks(tasks, { today: TODAY });

  assert.deepEqual(
    group(groups, GROUP_OVERDUE).items.map((t) => t.id),
    ["older", "old"],
    "overdue tasks appear in Overdue, oldest debt first"
  );
  assert.deepEqual(
    group(groups, GROUP_LATER).items.map((t) => t.id),
    ["future"],
    "Later holds only genuinely future work — this is the bug that was fixed"
  );
  assert.deepEqual(group(groups, GROUP_TODAY).items.map((t) => t.id), ["now"]);
  assert.deepEqual(group(groups, GROUP_TOMORROW).items.map((t) => t.id), ["soon"]);
  assert.deepEqual(group(groups, GROUP_SOMEDAY).items.map((t) => t.id), ["maybe"]);
});

test("a completed task from a past day is not overdue", () => {
  const tasks = [task({ id: "done-old", day: "2026-09-01", status: "done" })];
  const groups = groupTasks(tasks, { today: TODAY });
  assert.equal(group(groups, GROUP_OVERDUE).items.length, 0, "finished work is not a debt");
});

test("today's completed work stays visible below the open queue", () => {
  const tasks = [
    task({ id: "open", day: TODAY, order: 0 }),
    task({ id: "fin", day: TODAY, status: "done", doneAt: "2026-09-26T09:00:00Z" })
  ];
  const today = group(groupTasks(tasks, { today: TODAY }), GROUP_TODAY);
  assert.deepEqual(today.items.map((t) => t.id), ["open", "fin"]);
  assert.equal(today.openCount, 1, "openCount excludes the completed one");
});

test("groups report an open count that ignores done rows", () => {
  const tasks = [
    task({ id: "a", day: TODAY }),
    task({ id: "b", day: TODAY }),
    task({ id: "c", day: TODAY, status: "done" })
  ];
  const groups = groupTasks(tasks, { today: TODAY });
  assert.equal(group(groups, GROUP_TODAY).openCount, 2);
});

test("only single-day sections accept nudge controls", () => {
  assert.equal(isReorderable(GROUP_TODAY), true);
  assert.equal(isReorderable(GROUP_TOMORROW), true);
  assert.equal(isReorderable(GROUP_SOMEDAY), true);
  assert.equal(isReorderable(GROUP_OVERDUE), false, "overdue spans days; order is meaningless");
  assert.equal(isReorderable(GROUP_LATER), false);
});

test("grouping tolerates a missing today", () => {
  const groups = groupTasks([task({ id: "a", day: TODAY })], {});
  assert.equal(Array.isArray(groups), true);
  assert.equal(groups.length, 5);
});

// --- manual edits ----------------------------------------------------------

test("planEdit returns only changed, recognised fields", () => {
  const t = task({ id: "a", title: "Old", shape: "admin", size: "M", day: TODAY });
  const { fields, rejected } = planEdit(t, {
    title: "New",
    shape: "deep",
    size: "M",
    day: TODAY
  });
  assert.deepEqual(fields, { title: "New", shape: "deep" }, "unchanged fields cost no write");
  assert.deepEqual(rejected, []);
});

test("planEdit refuses an empty title and unknown enums", () => {
  const t = task({ id: "a", title: "Keep me" });
  const { fields, rejected } = planEdit(t, { title: "   ", shape: "urgent", size: "XXL", day: "nope" });
  assert.deepEqual(fields, {}, "nothing invalid reaches the store");
  assert.deepEqual(rejected.map((r) => r.field).sort(), ["day", "shape", "size", "title"]);
});

test("planEdit ignores fields that were not submitted", () => {
  const t = task({ id: "a" });
  const { fields } = planEdit(t, {});
  assert.deepEqual(fields, {});
});

test("planEdit on an unknown task reports rather than throws", () => {
  const { fields, rejected } = planEdit(null, { title: "x" });
  assert.deepEqual(fields, {});
  assert.equal(rejected[0].field, "task");
});
