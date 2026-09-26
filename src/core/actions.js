/**
 * The action layer: the boundary between what the model proposes and what is
 * written.
 *
 * The model never touches storage. It returns a list of proposed actions, and
 * this module compiles that list into a set of plain operation descriptors —
 * create, patch, delete, profile — which the shell then executes against the
 * document store. Planning is entirely pure: no IO, no clock, no randomness
 * except an injected id factory. That is what makes the safety property
 * testable rather than merely asserted.
 *
 * Two properties hold by construction:
 *
 *   1. The op whitelist is closed. There is no dynamic dispatch and no property
 *      lookup from a model-supplied string, so an unrecognised op cannot reach
 *      a writer. It is recorded as rejected instead of being dropped in
 *      silence, because a plan that half-applied is something the user needs to
 *      be told about.
 *   2. Every field is coerced by `task.js` before it lands in an op. A
 *      malformed or adversarial response can therefore produce a *wrong plan* —
 *      that risk is real and irreducible — but it cannot produce an arbitrary
 *      write.
 */

import { SOMEDAY, isAfter, isDayKey, isIsoDay } from "./day.js";
import {
  SHAPES,
  SIZES,
  coerceCount,
  coerceShape,
  coerceSize,
  coerceTitle,
  findTask,
  isOpen,
  nextOrder,
  normalizeTask,
  tasksForDay
} from "./task.js";

/** The closed set. Anything not on this list is rejected by name. */
export const AGENT_OPS = ["add", "order", "move", "done", "drop", "habit", "goal"];

export const MAX_ACTIONS = 40;
export const MAX_HABITS = 30;
export const MAX_GOALS = 15;
export const NOTE_MAX = 180;
export const PUSH_ALARM = 3;

function cloneTask(task) {
  return Object.assign({}, task);
}

function emptyProfile(profile) {
  const src = profile && typeof profile === "object" ? profile : {};
  return {
    goals: Array.isArray(src.goals) ? src.goals.slice() : [],
    habits: Array.isArray(src.habits) ? src.habits.slice() : []
  };
}

function appendCapped(list, text, cap) {
  const clean = String(text).replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  if (!clean) return { list, added: false };
  if (list.indexOf(clean) >= 0) return { list, added: false };
  const next = list.concat([clean]);
  return { list: next.length > cap ? next.slice(-cap) : next, added: true };
}

/**
 * Compile proposed actions into validated operations.
 *
 * @param {Array}  actions  raw `actions` array from the model
 * @param {Object} state    { tasks, profile } as currently held
 * @param {Object} ctx      { today, now, makeId }
 * @returns {{ops: Array, log: string[], rejected: Array, tasks: Array, profile: Object, alarms: Array}}
 */
export function planActions(actions, state, ctx) {
  const options = ctx || {};
  const today = isIsoDay(options.today) ? options.today : null;
  const now = typeof options.now === "string" ? options.now : new Date().toISOString();
  const makeId = typeof options.makeId === "function" ? options.makeId : defaultIdFactory();

  const ops = [];
  const log = [];
  const rejected = [];
  const alarms = [];

  // A working copy, mutated as the plan is built, so that later actions in the
  // same batch see the effect of earlier ones. An `add` followed by an `order`
  // referencing the new task works because ids are assigned here, up front,
  // rather than by the store on write.
  let tasks = (state && Array.isArray(state.tasks) ? state.tasks : []).map(cloneTask);
  let profile = emptyProfile(state && state.profile);
  let profileTouched = false;

  if (!Array.isArray(actions)) {
    if (actions !== undefined && actions !== null) {
      rejected.push({ index: -1, op: null, reason: "actions was not an array" });
    }
    return { ops, log, rejected, tasks, profile, alarms };
  }

  if (actions.length > MAX_ACTIONS) {
    rejected.push({
      index: MAX_ACTIONS,
      op: null,
      reason: `batch capped at ${MAX_ACTIONS}; ${actions.length - MAX_ACTIONS} dropped`
    });
  }

  actions.slice(0, MAX_ACTIONS).forEach((action, index) => {
    const reject = (reason) => rejected.push({ index, op: action && action.op, reason });

    if (!action || typeof action !== "object" || Array.isArray(action)) {
      reject("not an object");
      return;
    }
    if (AGENT_OPS.indexOf(action.op) < 0) {
      reject(`unknown op ${JSON.stringify(action.op)}`);
      return;
    }

    if (action.op === "add") {
      if (!String(action.title || "").trim()) {
        reject("add without a title");
        return;
      }
      const day = isDayKey(action.day) ? action.day : today || SOMEDAY;
      if (!isDayKey(action.day)) {
        rejected.push({ index, op: "add", reason: `day ${JSON.stringify(action.day)} not usable; used ${day}` });
      }
      if (action.shape !== undefined && SHAPES.indexOf(action.shape) < 0) {
        rejected.push({ index, op: "add", reason: `shape ${JSON.stringify(action.shape)} unknown; used admin` });
      }
      if (action.size !== undefined && SIZES.indexOf(String(action.size).toUpperCase()) < 0) {
        rejected.push({ index, op: "add", reason: `size ${JSON.stringify(action.size)} unknown; used M` });
      }
      const task = normalizeTask(
        {
          id: makeId(),
          title: coerceTitle(action.title),
          day,
          shape: coerceShape(action.shape),
          size: coerceSize(action.size),
          order: nextOrder(tasks, day),
          status: "open",
          pushes: 0,
          createdAt: now
        },
        { today }
      );
      tasks = tasks.concat([task]);
      ops.push({ kind: "create", id: task.id, task });
      log.push(`added "${task.title}"`);
      return;
    }

    if (action.op === "order") {
      if (!isDayKey(action.day)) {
        reject(`order for day ${JSON.stringify(action.day)}`);
        return;
      }
      if (!Array.isArray(action.ids)) {
        reject("order without an ids array");
        return;
      }
      const onDay = tasksForDay(tasks, action.day).filter(isOpen);
      const seen = new Set();
      let position = 0;
      action.ids.forEach((rawId) => {
        const id = String(rawId);
        if (seen.has(id)) {
          rejected.push({ index, op: "order", reason: `id ${id} listed twice` });
          return;
        }
        const task = onDay.find((t) => t.id === id);
        if (!task) {
          // Reordering cannot be a smuggled move: an id that is not already on
          // this day is refused rather than relocated.
          rejected.push({ index, op: "order", reason: `id ${id} is not an open task on ${action.day}` });
          return;
        }
        seen.add(id);
        if (task.order !== position) {
          task.order = position;
          ops.push({ kind: "patch", id, fields: { order: position } });
        }
        position += 1;
      });
      // Anything on the day the model forgot to mention keeps its relative
      // place after the listed ones, rather than colliding at index 0.
      onDay
        .filter((t) => !seen.has(t.id))
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .forEach((task) => {
          if (task.order !== position) {
            task.order = position;
            ops.push({ kind: "patch", id: task.id, fields: { order: position } });
          }
          position += 1;
        });
      if (seen.size) log.push(`reordered ${action.day === today ? "today" : action.day}`);
      return;
    }

    if (action.op === "move") {
      const task = findTask(tasks, action.id);
      if (!task) {
        reject(`move of unknown id ${JSON.stringify(action.id)}`);
        return;
      }
      if (!isDayKey(action.day)) {
        reject(`move to day ${JSON.stringify(action.day)}`);
        return;
      }
      if (task.day === action.day) {
        reject(`"${task.title}" is already on ${action.day}`);
        return;
      }
      // A push is a deferral, and only a deferral. Pulling work earlier, or off
      // "someday" onto a real date, must never be punished — otherwise the
      // counter stops measuring avoidance and starts measuring activity.
      const deferred = isAfter(action.day, task.day);
      const pushes = coerceCount(task.pushes) + (deferred ? 1 : 0);
      const fields = {
        day: action.day,
        pushes,
        order: nextOrder(tasks, action.day)
      };
      task.day = fields.day;
      task.pushes = pushes;
      task.order = fields.order;
      ops.push({ kind: "patch", id: task.id, fields });
      log.push(`moved "${task.title}" to ${action.day}${deferred ? ` (push ${pushes})` : ""}`);
      if (deferred && pushes >= PUSH_ALARM) {
        alarms.push({ id: task.id, title: task.title, pushes });
      }
      return;
    }

    if (action.op === "done") {
      const task = findTask(tasks, action.id);
      if (!task) {
        reject(`done for unknown id ${JSON.stringify(action.id)}`);
        return;
      }
      if (task.status === "done") {
        reject(`"${task.title}" was already done`);
        return;
      }
      task.status = "done";
      task.doneAt = now;
      ops.push({ kind: "patch", id: task.id, fields: { status: "done", doneAt: now } });
      log.push(`completed "${task.title}"`);
      return;
    }

    if (action.op === "drop") {
      const task = findTask(tasks, action.id);
      if (!task) {
        reject(`drop of unknown id ${JSON.stringify(action.id)}`);
        return;
      }
      tasks = tasks.filter((t) => t.id !== task.id);
      ops.push({ kind: "delete", id: task.id });
      log.push(`dropped "${task.title}"`);
      return;
    }

    if (action.op === "habit" || action.op === "goal") {
      const isHabit = action.op === "habit";
      if (!String(action.text || "").trim()) {
        reject(`${action.op} without text`);
        return;
      }
      const cap = isHabit ? MAX_HABITS : MAX_GOALS;
      const result = appendCapped(isHabit ? profile.habits : profile.goals, action.text, cap);
      if (!result.added) {
        reject(`${action.op} already recorded`);
        return;
      }
      if (isHabit) profile.habits = result.list;
      else profile.goals = result.list;
      profileTouched = true;
      log.push(`${isHabit ? "noted habit" : "recorded goal"}: ${result.list[result.list.length - 1]}`);
    }
  });

  if (profileTouched) {
    ops.push({ kind: "profile", profile: { goals: profile.goals, habits: profile.habits } });
  }

  return { ops, log, rejected, tasks, profile, alarms };
}

/**
 * Ids are generated on the client so that a batch can reference what it just
 * created. Time-ordered prefix keeps store keys roughly sorted; the random
 * suffix is collision avoidance, not a security property.
 */
export function defaultIdFactory() {
  let seq = 0;
  return function makeId() {
    seq += 1;
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 7);
    return `t${stamp}${seq.toString(36)}${rand}`;
  };
}

/** A deterministic factory, for tests and for replaying a plan. */
export function sequentialIdFactory(prefix) {
  let seq = 0;
  return function makeId() {
    seq += 1;
    return `${prefix || "t"}${seq}`;
  };
}

/** One-line human summary of what was refused, for the status line. */
export function describeRejections(rejected) {
  if (!rejected || !rejected.length) return "";
  if (rejected.length === 1) return `Ignored one instruction: ${rejected[0].reason}.`;
  return `Ignored ${rejected.length} instructions: ${rejected.map((r) => r.reason).join("; ")}.`;
}
