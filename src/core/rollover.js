/**
 * What to do with work whose day has passed.
 *
 * The queue has no hours, which means it also has no automatic sense of a day
 * ending. Close the tab on Friday with three things unfinished and open it on
 * Monday, and those three tasks are stranded on a date nobody is going to live
 * through again. Before this module they were not merely stranded — they were
 * filed under "Later this week", presented as upcoming.
 *
 * Rollover is the answer, and its one contentious decision is whether moving a
 * task off a day that has already passed should count as a push.
 *
 * It does. The push counter exists to notice avoidance, and a task that sat
 * through a whole day untouched is the most ordinary form avoidance takes. Not
 * counting it would let the most-avoided work be the only work with a clean
 * record. Two guards keep that honest rather than punitive:
 *
 *   · Rollover is never silent. It happens when the user asks for it, or under
 *     a setting they turned on themselves.
 *   · A task can earn at most one rollover push per calendar day, tracked in
 *     `rolledAt`. Opening the app five times on Monday does not cost five
 *     pushes, and a week away costs one, not seven.
 */

import { isIsoDay, isOverdue } from "./day.js";
import { coerceCount, isOpen, nextOrder } from "./task.js";
import { PUSH_ALARM } from "./actions.js";

export const ROLLOVER_OFF = "off";
export const ROLLOVER_ASK = "ask";
export const ROLLOVER_AUTO = "auto";
export const ROLLOVER_MODES = [ROLLOVER_OFF, ROLLOVER_ASK, ROLLOVER_AUTO];

export function coerceRolloverMode(value) {
  return ROLLOVER_MODES.indexOf(value) >= 0 ? value : ROLLOVER_ASK;
}

/** Open tasks sitting on a dated day before today, oldest first. */
export function findOverdue(tasks, options) {
  const today = options && isIsoDay(options.today) ? options.today : null;
  if (!today) return [];
  return (tasks || [])
    .filter((t) => isOpen(t) && isOverdue(t.day, today))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.order || 0) - (b.order || 0)));
}

/** True when this task has already taken its one rollover push today. */
export function alreadyRolledToday(task, today) {
  if (!task || !task.rolledAt) return false;
  return String(task.rolledAt).slice(0, 10) === today;
}

/**
 * Plan a rollover of overdue work onto today.
 *
 * @param {Array}  tasks
 * @param {Object} options { today, now, ids?, countPush? }
 *        `ids` limits the rollover to a subset; omitted means all overdue.
 *        `countPush` defaults to true; false rolls without touching the counter.
 */
export function planRollover(tasks, options) {
  const opts = options || {};
  const today = isIsoDay(opts.today) ? opts.today : null;
  const now = typeof opts.now === "string" ? opts.now : new Date().toISOString();
  const countPush = opts.countPush !== false;
  const limit = Array.isArray(opts.ids) ? new Set(opts.ids.map(String)) : null;

  const ops = [];
  const log = [];
  const alarms = [];
  const moved = [];
  if (!today) return { ops, log, alarms, moved };

  const due = findOverdue(tasks, { today }).filter((t) => !limit || limit.has(t.id));
  if (!due.length) return { ops, log, alarms, moved };

  // Orders continue from whatever today already holds, and older work lands
  // first, so the queue reads oldest-debt-first rather than shuffled.
  let position = nextOrder(tasks, today);

  due.forEach((task) => {
    const chargeable = countPush && !alreadyRolledToday(task, today);
    const pushes = coerceCount(task.pushes) + (chargeable ? 1 : 0);
    const fields = { day: today, order: position, pushes };
    if (chargeable) fields.rolledAt = now;
    position += 1;
    ops.push({ kind: "patch", id: task.id, fields });
    moved.push({ id: task.id, title: task.title, from: task.day, pushes, charged: chargeable });
    if (chargeable && pushes >= PUSH_ALARM) {
      alarms.push({ id: task.id, title: task.title, pushes });
    }
  });

  log.push(
    `rolled ${due.length} overdue task${due.length === 1 ? "" : "s"} to today` +
      (countPush ? "" : " without counting pushes")
  );
  return { ops, log, alarms, moved };
}

/** Status-line copy for the overdue banner. */
export function describeOverdue(due) {
  if (!due || !due.length) return "";
  const oldest = due[0];
  const n = due.length;
  return `${n} task${n === 1 ? "" : "s"} still open from ${
    n === 1 ? oldest.day : `as far back as ${oldest.day}`
  }.`;
}
