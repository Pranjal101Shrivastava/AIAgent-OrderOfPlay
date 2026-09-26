/**
 * The task schema, its coercions, and the day grouping the UI renders from.
 *
 * Nothing here trusts its input. Every field arrives from one of three places
 * that can all be wrong in different ways: a language model's JSON, a document
 * store written by an older version of this page, or an imported backup file.
 * So each field has a coercion that always returns something valid, and the
 * normaliser is the only way a task enters the running state.
 */

import { SOMEDAY, addDays, compareDays, isDayKey, isIsoDay, isOverdue } from "./day.js";

export const SHAPES = ["deep", "admin", "errand", "social"];
export const SIZES = ["S", "M", "L"];
export const STATUSES = ["open", "done"];

export const TITLE_MAX = 200;
export const DEFAULT_SHAPE = "admin";
export const DEFAULT_SIZE = "M";

export const SHAPE_LABEL = {
  deep: "deep work",
  admin: "admin",
  errand: "errand",
  social: "social"
};

export const SIZE_LABEL = { S: "small", M: "medium", L: "large" };

/** Group identifiers, in render order. */
export const GROUP_OVERDUE = "overdue";
export const GROUP_TODAY = "today";
export const GROUP_TOMORROW = "tomorrow";
export const GROUP_LATER = "later";
export const GROUP_SOMEDAY = "someday";

export function coerceTitle(value) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Untitled";
  return text.slice(0, TITLE_MAX);
}

export function coerceShape(value) {
  return SHAPES.indexOf(value) >= 0 ? value : DEFAULT_SHAPE;
}

export function coerceSize(value) {
  if (typeof value === "string" && SIZES.indexOf(value.toUpperCase()) >= 0) {
    return value.toUpperCase();
  }
  return DEFAULT_SIZE;
}

export function coerceDay(value, fallback) {
  if (isDayKey(value)) return value;
  return isDayKey(fallback) ? fallback : SOMEDAY;
}

export function coerceStatus(value) {
  return value === "done" ? "done" : "open";
}

/** Non-negative integer, clamped. Guards a corrupt `pushes` from going negative. */
export function coerceCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 9999);
}

export function coerceOrder(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(Math.floor(n), 99999));
}

function coerceStamp(value) {
  if (typeof value !== "string" || !value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * The single entry point for a task into running state.
 *
 * `today` is required because an unusable `day` has to land somewhere, and
 * today is the only honest default — a task with no day is a task for now, not
 * a task that quietly disappears into "someday".
 */
export function normalizeTask(raw, options) {
  const opts = options || {};
  const today = isIsoDay(opts.today) ? opts.today : null;
  const src = raw && typeof raw === "object" ? raw : {};
  const status = coerceStatus(src.status);
  return {
    id: String(src.id === undefined || src.id === null ? "" : src.id),
    title: coerceTitle(src.title),
    day: coerceDay(src.day, today || SOMEDAY),
    shape: coerceShape(src.shape),
    size: coerceSize(src.size),
    order: coerceOrder(src.order),
    status,
    pushes: coerceCount(src.pushes),
    createdAt: coerceStamp(src.createdAt),
    doneAt: status === "done" ? coerceStamp(src.doneAt) : null,
    rolledAt: coerceStamp(src.rolledAt)
  };
}

/** The shape written to the store. Ids live in the document key, not the body. */
export function toDocument(task) {
  return {
    title: task.title,
    day: task.day,
    shape: task.shape,
    size: task.size,
    order: task.order,
    status: task.status,
    pushes: task.pushes,
    createdAt: task.createdAt,
    doneAt: task.doneAt,
    rolledAt: task.rolledAt
  };
}

export function isOpen(task) {
  return !!task && task.status !== "done";
}

export function openTasks(tasks) {
  return (tasks || []).filter(isOpen);
}

export function findTask(tasks, id) {
  const key = String(id);
  return (tasks || []).find((t) => t && t.id === key) || null;
}

export function tasksForDay(tasks, day) {
  return (tasks || []).filter((t) => t && t.day === day);
}

export function sortByOrder(tasks) {
  return (tasks || []).slice().sort((a, b) => {
    const delta = (a.order || 0) - (b.order || 0);
    if (delta !== 0) return delta;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

/** The index a new task takes at the end of its day. */
export function nextOrder(tasks, day) {
  return tasksForDay(openTasks(tasks), day).length;
}

/** The full ordered id list for one day — the payload of an `order` action. */
export function orderedIds(tasks, day) {
  return sortByOrder(tasksForDay(openTasks(tasks), day)).map((t) => t.id);
}

/**
 * Bucket tasks into the sections the board renders.
 *
 * The overdue bucket is the correctness fix in this version. Before it existed,
 * the day router was a chain of equality tests against today, tomorrow and
 * "someday", with everything else falling through to "Later this week" — so a
 * task from last Tuesday was displayed, in earnest, as upcoming. Nothing in the
 * UI ever said a day had passed, which is exactly the failure a deferral
 * tracker cannot have.
 */
export function groupTasks(tasks, options) {
  const opts = options || {};
  const today = isIsoDay(opts.today) ? opts.today : null;
  const tomorrow = today ? addDays(today, 1) : null;
  const all = tasks || [];

  const groups = [
    { key: GROUP_OVERDUE, kind: GROUP_OVERDUE, name: "Overdue", items: [] },
    { key: GROUP_TODAY, kind: GROUP_TODAY, name: "Today", day: today, items: [] },
    { key: GROUP_TOMORROW, kind: GROUP_TOMORROW, name: "Tomorrow", day: tomorrow, items: [] },
    { key: GROUP_LATER, kind: GROUP_LATER, name: "Later", items: [] },
    { key: GROUP_SOMEDAY, kind: GROUP_SOMEDAY, name: "Someday", items: [] }
  ];
  const byKind = {};
  groups.forEach((g) => {
    byKind[g.kind] = g;
  });

  all.filter(isOpen).forEach((task) => {
    if (isOverdue(task.day, today)) byKind[GROUP_OVERDUE].items.push(task);
    else if (today && task.day === today) byKind[GROUP_TODAY].items.push(task);
    else if (tomorrow && task.day === tomorrow) byKind[GROUP_TOMORROW].items.push(task);
    else if (task.day === SOMEDAY) byKind[GROUP_SOMEDAY].items.push(task);
    else byKind[GROUP_LATER].items.push(task);
  });

  // Overdue and Later span several days, so they sort by day first. The two
  // single-day buckets sort purely by the order the user or agent chose.
  [GROUP_OVERDUE, GROUP_LATER].forEach((kind) => {
    byKind[kind].items.sort((a, b) => {
      const byDay = compareDays(a.day, b.day);
      return byDay !== 0 ? byDay : (a.order || 0) - (b.order || 0);
    });
  });
  [GROUP_TODAY, GROUP_TOMORROW, GROUP_SOMEDAY].forEach((kind) => {
    byKind[kind].items = sortByOrder(byKind[kind].items);
  });

  // Today's completed work stays visible, below the open queue, as evidence.
  const doneToday = today
    ? all
        .filter((t) => t && t.status === "done" && t.day === today)
        .sort((a, b) => String(a.doneAt || "") < String(b.doneAt || "") ? -1 : 1)
    : [];
  byKind[GROUP_TODAY].items = byKind[GROUP_TODAY].items.concat(doneToday);

  groups.forEach((g) => {
    g.openCount = g.items.filter(isOpen).length;
  });
  return groups;
}

/** Only these sections let a task be nudged with the up/down controls. */
export function isReorderable(kind) {
  return kind === GROUP_TODAY || kind === GROUP_TOMORROW || kind === GROUP_SOMEDAY;
}

/**
 * Validate a manual edit. Returns only the fields that are both recognised and
 * changed, so an untouched form submits nothing and costs no write.
 */
export function planEdit(task, patch) {
  const fields = {};
  const rejected = [];
  if (!task) return { fields, rejected: [{ field: "task", reason: "unknown task" }] };
  const src = patch && typeof patch === "object" ? patch : {};

  if ("title" in src) {
    const title = coerceTitle(src.title);
    if (!String(src.title || "").trim()) rejected.push({ field: "title", reason: "empty" });
    else if (title !== task.title) fields.title = title;
  }
  if ("shape" in src) {
    if (SHAPES.indexOf(src.shape) < 0) rejected.push({ field: "shape", reason: "unknown shape" });
    else if (src.shape !== task.shape) fields.shape = src.shape;
  }
  if ("size" in src) {
    const size = coerceSize(src.size);
    if (SIZES.indexOf(String(src.size).toUpperCase()) < 0) {
      rejected.push({ field: "size", reason: "unknown size" });
    } else if (size !== task.size) fields.size = size;
  }
  if ("day" in src) {
    if (!isDayKey(src.day)) rejected.push({ field: "day", reason: "not a day" });
    else if (src.day !== task.day) fields.day = src.day;
  }
  return { fields, rejected };
}
