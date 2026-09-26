import test from "node:test";
import assert from "node:assert/strict";

import { SOMEDAY } from "../src/core/day.js";
import { normalizeTask } from "../src/core/task.js";
import { sequentialIdFactory } from "../src/core/actions.js";
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  IMPORT_MERGE,
  IMPORT_REPLACE,
  backupFilename,
  buildBackup,
  downloadErrorCopy,
  planImport,
  readBackup
} from "../src/core/backup.js";

const TODAY = "2026-09-26";
const NOW = "2026-09-26T10:00:00.000Z";

function st(rows, profile) {
  return {
    tasks: (rows || []).map((r) => normalizeTask(r, { today: TODAY })),
    profile: profile || { goals: [], habits: [] },
    log: []
  };
}

test("buildBackup captures tasks, profile and counts", () => {
  const backup = buildBackup(
    st([{ id: "a", title: "One" }, { id: "b", title: "Two", status: "done", doneAt: NOW }], {
      goals: ["ship it"],
      habits: ["late nights"]
    }),
    { now: NOW, timeZone: "Asia/Kolkata" }
  );
  assert.equal(backup.kind, BACKUP_KIND);
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.exportedAt, NOW);
  assert.equal(backup.timeZone, "Asia/Kolkata");
  assert.deepEqual(backup.counts, { tasks: 2, open: 1 });
  assert.equal(backup.tasks.length, 2);
  assert.equal(backup.tasks[0].id, "a", "ids are carried in the export");
  assert.deepEqual(backup.profile.goals, ["ship it"]);
});

test("a backup round-trips without loss", () => {
  const before = st(
    [
      { id: "a", title: "Deep thing", day: TODAY, shape: "deep", size: "L", order: 2, pushes: 3 },
      { id: "b", title: "Maybe", day: SOMEDAY, shape: "social", size: "S" }
    ],
    { goals: ["g1"], habits: ["h1"] }
  );
  const text = JSON.stringify(buildBackup(before, { now: NOW }));
  const read = readBackup(text, { today: TODAY });

  assert.equal(read.ok, true);
  assert.deepEqual(read.notes, []);
  assert.deepEqual(read.data.tasks, before.tasks, "every field survives the trip");
  assert.deepEqual(read.data.profile, { goals: ["g1"], habits: ["h1"] });
});

test("readBackup refuses files that are not ours", () => {
  assert.match(readBackup("not json", {}).error, /valid JSON/);
  assert.match(readBackup("[]", {}).error, /backup object/);
  assert.match(readBackup('{"kind":"something-else"}', {}).error, /isn't an Order of Play backup/);
  assert.match(readBackup(JSON.stringify({ kind: BACKUP_KIND }), {}).error, /version number/);
  assert.match(
    readBackup(JSON.stringify({ kind: BACKUP_KIND, version: 1 }), {}).error,
    /no task list/
  );
});

test("readBackup refuses a version from the future", () => {
  const out = readBackup(
    JSON.stringify({ kind: BACKUP_KIND, version: BACKUP_VERSION + 1, tasks: [] }),
    {}
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /reads up to/);
});

test("readBackup repairs bad rows and reports each one", () => {
  const out = readBackup(
    JSON.stringify({
      kind: BACKUP_KIND,
      version: 1,
      tasks: [
        { id: "good", title: "Fine", day: TODAY },
        "not an object",
        { title: "No id" },
        { id: "good", title: "Duplicate id" },
        { id: "weird", title: "Bad day", day: "2026-02-30", shape: "nope", pushes: -3 }
      ]
    }),
    { today: TODAY }
  );
  assert.equal(out.ok, true, "one bad row does not cost the user the good ones");
  assert.deepEqual(out.data.tasks.map((t) => t.id), ["good", "weird"]);
  assert.equal(out.notes.length, 3);
  const weird = out.data.tasks[1];
  assert.equal(weird.day, TODAY);
  assert.equal(weird.shape, "admin");
  assert.equal(weird.pushes, 0);
});

test("readBackup accepts an object as well as a string", () => {
  const out = readBackup({ kind: BACKUP_KIND, version: 1, tasks: [] }, { today: TODAY });
  assert.equal(out.ok, true);
});

test("readBackup filters non-string profile entries", () => {
  const out = readBackup(
    JSON.stringify({
      kind: BACKUP_KIND,
      version: 1,
      tasks: [],
      profile: { goals: ["real", 42, null, "  "], habits: "not a list" }
    }),
    { today: TODAY }
  );
  assert.deepEqual(out.data.profile.goals, ["real"]);
  assert.deepEqual(out.data.profile.habits, []);
});

test("replace import clears what is there and writes the file", () => {
  const current = st([{ id: "old1" }, { id: "old2" }], { goals: ["mine"], habits: [] });
  const incoming = readBackup(
    JSON.stringify(buildBackup(st([{ id: "new1" }], { goals: ["theirs"], habits: [] }), { now: NOW })),
    { today: TODAY }
  ).data;

  const plan = planImport(current, incoming, { mode: IMPORT_REPLACE });
  assert.equal(plan.removed, 2);
  assert.equal(plan.added, 1);
  assert.deepEqual(
    plan.ops.filter((o) => o.kind === "delete").map((o) => o.id),
    ["old1", "old2"]
  );
  const profile = plan.ops.find((o) => o.kind === "profile");
  assert.deepEqual(profile.profile.goals, ["theirs"], "replace means replace");
});

test("merge import re-ids incoming tasks so nothing is overwritten", () => {
  const current = st([{ id: "shared", title: "Mine" }], { goals: ["mine"], habits: [] });
  const incoming = readBackup(
    JSON.stringify(
      buildBackup(st([{ id: "shared", title: "Theirs" }], { goals: ["theirs"], habits: [] }), {
        now: NOW
      })
    ),
    { today: TODAY }
  ).data;

  const plan = planImport(current, incoming, {
    mode: IMPORT_MERGE,
    makeId: sequentialIdFactory("m")
  });
  assert.equal(plan.removed, 0, "merge destroys nothing");
  const created = plan.ops.filter((o) => o.kind === "create");
  assert.equal(created.length, 1);
  assert.equal(created[0].id, "m1", "the colliding id is replaced");
  assert.equal(created[0].task.title, "Theirs");
  const profile = plan.ops.find((o) => o.kind === "profile");
  assert.deepEqual(profile.profile.goals, ["mine", "theirs"], "profiles union");
});

test("merge without an id factory refuses rather than colliding", () => {
  const plan = planImport(st([]), { tasks: [], profile: { goals: [], habits: [] } }, { mode: IMPORT_MERGE });
  assert.deepEqual(plan.ops, []);
  assert.match(plan.error, /id factory/);
});

test("an unknown import mode falls back to replace", () => {
  const plan = planImport(st([{ id: "a" }]), { tasks: [], profile: { goals: [], habits: [] } }, {
    mode: "sideways"
  });
  assert.equal(plan.mode, IMPORT_REPLACE);
});

test("merge does not duplicate a profile line already present", () => {
  const current = st([], { goals: ["same"], habits: [] });
  const plan = planImport(current, { tasks: [], profile: { goals: ["same"], habits: [] } }, {
    mode: IMPORT_MERGE,
    makeId: sequentialIdFactory("m")
  });
  assert.deepEqual(plan.ops.find((o) => o.kind === "profile").profile.goals, ["same"]);
});

test("backupFilename is dated and stable", () => {
  assert.equal(backupFilename(NOW), "order-of-play-2026-09-26.json");
});

test("downloadErrorCopy names each ordinary refusal", () => {
  assert.equal(downloadErrorCopy("declined"), "Export cancelled.");
  assert.match(downloadErrorCopy("rate_limited"), /try again/i);
  assert.match(downloadErrorCopy("too_large"), /too large/i);
  assert.match(downloadErrorCopy("unavailable"), /isn't available/);
});

test("downloadErrorCopy does not leak inherited properties", () => {
  assert.match(downloadErrorCopy("toString"), /didn't save/);
  assert.match(downloadErrorCopy("__proto__"), /didn't save/);
  assert.match(downloadErrorCopy(undefined), /didn't save/);
  assert.match(downloadErrorCopy("some_future_code"), /didn't save/);
});
