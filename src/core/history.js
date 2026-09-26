/**
 * Undo, for a queue that a language model is allowed to rearrange.
 *
 * A single turn can legitimately produce a dozen writes: four adds, a reorder
 * across two days, a move that charges a push. When that plan is wrong — and a
 * model asked to reshuffle a day will sometimes be confidently wrong — there
 * was previously no way back. The user's only recourse was to reconstruct the
 * previous order from memory, by hand, which is a worse job than the one they
 * delegated.
 *
 * The approach is snapshot-and-diff rather than an inverse-operation log.
 * Inverting operations individually is where undo implementations go wrong:
 * every op needs a correct inverse, the inverses have to compose in reverse,
 * and one mistake corrupts state silently. A snapshot cannot be wrong about
 * what the state was. The cost is memory, and for a single-user queue of a few
 * hundred tasks that cost is irrelevant.
 *
 * Restoring is itself expressed as ops and handed to the same executor that
 * applies agent plans, so there is exactly one code path that writes.
 */

const TRACKED_FIELDS = [
  "title",
  "day",
  "shape",
  "size",
  "order",
  "status",
  "pushes",
  "createdAt",
  "doneAt",
  "rolledAt"
];

export const HISTORY_LIMIT = 25;

/** A structural copy of everything undo is responsible for. */
export function snapshot(state) {
  const src = state && typeof state === "object" ? state : {};
  const profile = src.profile && typeof src.profile === "object" ? src.profile : {};
  return {
    tasks: (Array.isArray(src.tasks) ? src.tasks : []).map((t) => Object.assign({}, t)),
    profile: {
      goals: Array.isArray(profile.goals) ? profile.goals.slice() : [],
      habits: Array.isArray(profile.habits) ? profile.habits.slice() : []
    }
  };
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

/**
 * The ops that turn `current` into `target`.
 *
 * Only changed fields are patched, so undoing a reorder of three tasks writes
 * three documents rather than the whole queue.
 */
export function planRestore(current, target) {
  const from = snapshot(current);
  const to = snapshot(target);
  const ops = [];

  const byId = new Map();
  from.tasks.forEach((t) => byId.set(t.id, t));
  const wanted = new Set();

  to.tasks.forEach((task) => {
    wanted.add(task.id);
    const existing = byId.get(task.id);
    if (!existing) {
      ops.push({ kind: "create", id: task.id, task });
      return;
    }
    const fields = {};
    TRACKED_FIELDS.forEach((key) => {
      const a = existing[key] === undefined ? null : existing[key];
      const b = task[key] === undefined ? null : task[key];
      if (a !== b) fields[key] = task[key] === undefined ? null : task[key];
    });
    if (Object.keys(fields).length) ops.push({ kind: "patch", id: task.id, fields });
  });

  from.tasks.forEach((task) => {
    if (!wanted.has(task.id)) ops.push({ kind: "delete", id: task.id });
  });

  if (
    !sameList(from.profile.goals, to.profile.goals) ||
    !sameList(from.profile.habits, to.profile.habits)
  ) {
    ops.push({ kind: "profile", profile: { goals: to.profile.goals, habits: to.profile.habits } });
  }

  return { ops, changed: ops.length };
}

/**
 * A bounded undo/redo stack.
 *
 * `record` is called with the state as it was *before* a change, together with
 * a label describing the change, so the UI can offer "Undo reshuffle" rather
 * than a bare arrow. Recording a new change clears the redo branch, which is
 * the behaviour every editor has trained people to expect.
 */
export function createHistory(limit) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HISTORY_LIMIT;
  let past = [];
  let future = [];

  return {
    get limit() {
      return cap;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    get undoLabel() {
      return past.length ? past[past.length - 1].label : "";
    },
    get redoLabel() {
      return future.length ? future[future.length - 1].label : "";
    },
    get depth() {
      return past.length;
    },

    record(before, label) {
      past.push({ state: snapshot(before), label: String(label || "change") });
      if (past.length > cap) past = past.slice(-cap);
      future = [];
    },

    /** Returns the ops to apply, or null when there is nothing to undo. */
    undo(current) {
      if (!past.length) return null;
      const entry = past.pop();
      future.push({ state: snapshot(current), label: entry.label });
      if (future.length > cap) future = future.slice(-cap);
      const plan = planRestore(current, entry.state);
      return { ops: plan.ops, label: entry.label, state: entry.state };
    },

    redo(current) {
      if (!future.length) return null;
      const entry = future.pop();
      past.push({ state: snapshot(current), label: entry.label });
      if (past.length > cap) past = past.slice(-cap);
      const plan = planRestore(current, entry.state);
      return { ops: plan.ops, label: entry.label, state: entry.state };
    },

    clear() {
      past = [];
      future = [];
    }
  };
}
