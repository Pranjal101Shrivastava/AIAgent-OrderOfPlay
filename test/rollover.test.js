import test from "node:test";
import assert from "node:assert/strict";

import { SOMEDAY } from "../src/core/day.js";
import { normalizeTask } from "../src/core/task.js";
import { PUSH_ALARM } from "../src/core/actions.js";
import {
  ROLLOVER_ASK,
  ROLLOVER_AUTO,
  ROLLOVER_OFF,
  alreadyRolledToday,
  coerceRolloverMode,
  describeOverdue,
  findOverdue,
  planRollover
} from "../src/core/rollover.js";

const TODAY = "2026-09-26";
const NOW = "2026-09-26T10:00:00.000Z";

function tasks(rows) {
  return rows.map((r) => normalizeTask(r, { today: TODAY }));
}

test("findOverdue returns open past work, oldest first", () => {
  const out = findOverdue(
    tasks([
      { id: "a", day: "2026-09-20" },
      { id: "b", day: "2026-09-10" },
      { id: "c", day: TODAY },
      { id: "d", day: "2026-09-30" },
      { id: "e", day: SOMEDAY },
      { id: "f", day: "2026-09-01", status: "done" }
    ]),
    { today: TODAY }
  );
  assert.deepEqual(out.map((t) => t.id), ["b", "a"]);
});

test("findOverdue is empty without a today", () => {
  assert.deepEqual(findOverdue(tasks([{ id: "a", day: "2020-01-01" }]), {}), []);
});

test("rollover moves overdue work to today and charges one push each", () => {
  const result = planRollover(
    tasks([
      { id: "a", day: "2026-09-20", pushes: 0 },
      { id: "b", day: "2026-09-24", pushes: 1 }
    ]),
    { today: TODAY, now: NOW }
  );
  assert.equal(result.ops.length, 2);
  assert.equal(result.ops[0].fields.day, TODAY);
  assert.equal(result.ops[0].fields.pushes, 1);
  assert.equal(result.ops[1].fields.pushes, 2);
  assert.equal(result.ops[0].fields.rolledAt, NOW);
});

test("rollover continues the order sequence today already holds", () => {
  const result = planRollover(
    tasks([
      { id: "old", day: "2026-09-20" },
      { id: "here", day: TODAY, order: 0 }
    ]),
    { today: TODAY, now: NOW }
  );
  assert.equal(result.ops[0].fields.order, 1, "existing work keeps its place at the top");
});

test("the oldest debt lands first", () => {
  const result = planRollover(
    tasks([
      { id: "recent", day: "2026-09-25" },
      { id: "ancient", day: "2026-08-01" }
    ]),
    { today: TODAY, now: NOW }
  );
  assert.deepEqual(result.ops.map((o) => o.id), ["ancient", "recent"]);
  assert.deepEqual(result.ops.map((o) => o.fields.order), [0, 1]);
});

test("a task cannot be charged twice in one day", () => {
  const rolled = tasks([{ id: "a", day: "2026-09-20", pushes: 4, rolledAt: "2026-09-26T08:00:00.000Z" }]);
  const result = planRollover(rolled, { today: TODAY, now: NOW });
  assert.equal(result.ops[0].fields.pushes, 4, "opening the app again costs nothing");
  assert.equal("rolledAt" in result.ops[0].fields, false, "the stamp is not refreshed");
  assert.equal(result.moved[0].charged, false);
});

test("a week away costs one push, not seven", () => {
  const result = planRollover(tasks([{ id: "a", day: "2026-09-19", pushes: 0 }]), {
    today: TODAY,
    now: NOW
  });
  assert.equal(result.ops[0].fields.pushes, 1);
});

test("alreadyRolledToday compares calendar days, not instants", () => {
  assert.equal(alreadyRolledToday({ rolledAt: "2026-09-26T23:59:59Z" }, TODAY), true);
  assert.equal(alreadyRolledToday({ rolledAt: "2026-09-25T23:59:59Z" }, TODAY), false);
  assert.equal(alreadyRolledToday({}, TODAY), false);
  assert.equal(alreadyRolledToday(null, TODAY), false);
});

test("countPush false rolls without touching the counter", () => {
  const result = planRollover(tasks([{ id: "a", day: "2026-09-20", pushes: 2 }]), {
    today: TODAY,
    now: NOW,
    countPush: false
  });
  assert.equal(result.ops[0].fields.pushes, 2);
  assert.equal("rolledAt" in result.ops[0].fields, false);
  assert.match(result.log[0], /without counting pushes/);
});

test("ids limits the rollover to a chosen subset", () => {
  const result = planRollover(
    tasks([
      { id: "a", day: "2026-09-20" },
      { id: "b", day: "2026-09-21" }
    ]),
    { today: TODAY, now: NOW, ids: ["b"] }
  );
  assert.deepEqual(result.ops.map((o) => o.id), ["b"]);
});

test("rollover raises an alarm when it trips the threshold", () => {
  const result = planRollover(
    tasks([{ id: "a", title: "The paper", day: "2026-09-20", pushes: PUSH_ALARM - 1 }]),
    { today: TODAY, now: NOW }
  );
  assert.deepEqual(result.alarms, [{ id: "a", title: "The paper", pushes: PUSH_ALARM }]);
});

test("nothing overdue means no ops and no log noise", () => {
  const result = planRollover(tasks([{ id: "a", day: TODAY }]), { today: TODAY, now: NOW });
  assert.deepEqual(result.ops, []);
  assert.deepEqual(result.log, []);
});

test("someday is never rolled", () => {
  const result = planRollover(tasks([{ id: "a", day: SOMEDAY }]), { today: TODAY, now: NOW });
  assert.deepEqual(result.ops, []);
});

test("coerceRolloverMode defaults to ask", () => {
  assert.equal(coerceRolloverMode(ROLLOVER_AUTO), ROLLOVER_AUTO);
  assert.equal(coerceRolloverMode(ROLLOVER_OFF), ROLLOVER_OFF);
  assert.equal(coerceRolloverMode("whenever"), ROLLOVER_ASK);
  assert.equal(coerceRolloverMode(undefined), ROLLOVER_ASK);
});

test("describeOverdue reads naturally for one and for many", () => {
  assert.equal(describeOverdue([]), "");
  assert.match(describeOverdue([{ day: "2026-09-20" }]), /1 task still open from 2026-09-20/);
  assert.match(
    describeOverdue([{ day: "2026-09-10" }, { day: "2026-09-20" }]),
    /2 tasks still open from as far back as 2026-09-10/
  );
});
