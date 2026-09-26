/**
 * Getting the data out, and back in.
 *
 * Everything this agent knows lives in one artifact's document store. That store
 * is durable and it is not yours: you cannot query it, point another tool at it,
 * or keep a copy. For a tool meant to be used daily for months, and to
 * accumulate habits that are the whole payoff, "your data is somewhere you
 * cannot reach" is a product defect rather than an infrastructure detail.
 *
 * Export is therefore plain, versioned, human-readable JSON. Import validates
 * every task through the same normaliser the running state uses, so a
 * hand-edited or downgraded file cannot introduce a shape the app has to defend
 * against later.
 */

import { isIsoDay } from "./day.js";
import { normalizeTask, toDocument } from "./task.js";
import { MAX_GOALS, MAX_HABITS } from "./actions.js";

export const BACKUP_KIND = "order-of-play.backup";
export const BACKUP_VERSION = 1;

export const IMPORT_REPLACE = "replace";
export const IMPORT_MERGE = "merge";
export const IMPORT_MODES = [IMPORT_REPLACE, IMPORT_MERGE];

/** A complete, portable copy of the agent's state. */
export function buildBackup(state, options) {
  const opts = options || {};
  const src = state && typeof state === "object" ? state : {};
  const profile = src.profile && typeof src.profile === "object" ? src.profile : {};
  const tasks = Array.isArray(src.tasks) ? src.tasks : [];
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: typeof opts.now === "string" ? opts.now : new Date().toISOString(),
    timeZone: typeof opts.timeZone === "string" ? opts.timeZone : "",
    counts: {
      tasks: tasks.length,
      open: tasks.filter((t) => t && t.status !== "done").length
    },
    tasks: tasks.map((task) => Object.assign({ id: task.id }, toDocument(task))),
    profile: {
      goals: Array.isArray(profile.goals) ? profile.goals.slice(0, MAX_GOALS) : [],
      habits: Array.isArray(profile.habits) ? profile.habits.slice(0, MAX_HABITS) : []
    },
    log: Array.isArray(src.log) ? src.log.slice(-100) : []
  };
}

export function backupFilename(now) {
  const stamp = (typeof now === "string" ? now : new Date().toISOString()).slice(0, 10);
  return `order-of-play-${stamp}.json`;
}

/**
 * Validate an export back into usable state.
 *
 * Refuses on the things that mean "this is not our file" — wrong kind, a version
 * from the future, no task array. Everything else is repaired and reported, so
 * one malformed row does not cost the user the other two hundred.
 */
export function readBackup(input, options) {
  const opts = options || {};
  const today = isIsoDay(opts.today) ? opts.today : null;
  const notes = [];

  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      return { ok: false, error: "That file isn't valid JSON.", notes, data: null };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "That file doesn't contain a backup object.", notes, data: null };
  }
  if (raw.kind !== BACKUP_KIND) {
    return {
      ok: false,
      error: "That isn't an Order of Play backup.",
      notes,
      data: null
    };
  }
  const version = Number(raw.version);
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, error: "That backup has no usable version number.", notes, data: null };
  }
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `That backup is version ${version}; this build reads up to ${BACKUP_VERSION}.`,
      notes,
      data: null
    };
  }
  if (!Array.isArray(raw.tasks)) {
    return { ok: false, error: "That backup has no task list.", notes, data: null };
  }

  const seen = new Set();
  const tasks = [];
  raw.tasks.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      notes.push(`Row ${index + 1} was not an object and was skipped.`);
      return;
    }
    const task = normalizeTask(row, { today });
    if (!task.id) {
      notes.push(`Row ${index + 1} ("${task.title}") had no id and was skipped.`);
      return;
    }
    if (seen.has(task.id)) {
      notes.push(`Row ${index + 1} repeated id ${task.id} and was skipped.`);
      return;
    }
    seen.add(task.id);
    tasks.push(task);
  });

  const profileSrc = raw.profile && typeof raw.profile === "object" ? raw.profile : {};
  const strings = (list, cap) =>
    (Array.isArray(list) ? list : [])
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim())
      .slice(-cap);

  return {
    ok: true,
    error: "",
    notes,
    data: {
      version,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
      timeZone: typeof raw.timeZone === "string" ? raw.timeZone : "",
      tasks,
      profile: {
        goals: strings(profileSrc.goals, MAX_GOALS),
        habits: strings(profileSrc.habits, MAX_HABITS)
      },
      log: Array.isArray(raw.log) ? raw.log.filter((e) => e && typeof e === "object") : []
    }
  };
}

/**
 * The ops that bring imported data into the live store.
 *
 * `replace` is destructive and says so in the UI. `merge` keeps what is there
 * and re-ids every incoming task, because two exports of the same queue share
 * ids and merging on id would silently overwrite rather than combine.
 */
export function planImport(current, incoming, options) {
  const opts = options || {};
  const mode = IMPORT_MODES.indexOf(opts.mode) >= 0 ? opts.mode : IMPORT_REPLACE;
  const makeId = typeof opts.makeId === "function" ? opts.makeId : null;
  const existing = Array.isArray(current && current.tasks) ? current.tasks : [];
  const existingProfile =
    current && current.profile && typeof current.profile === "object"
      ? current.profile
      : { goals: [], habits: [] };
  const ops = [];

  if (mode === IMPORT_REPLACE) {
    existing.forEach((task) => ops.push({ kind: "delete", id: task.id }));
    incoming.tasks.forEach((task) => ops.push({ kind: "create", id: task.id, task }));
    ops.push({
      kind: "profile",
      profile: { goals: incoming.profile.goals.slice(), habits: incoming.profile.habits.slice() }
    });
    return {
      ops,
      mode,
      added: incoming.tasks.length,
      removed: existing.length
    };
  }

  if (!makeId) {
    return { ops: [], mode, added: 0, removed: 0, error: "merge needs an id factory" };
  }

  incoming.tasks.forEach((task) => {
    const copy = Object.assign({}, task, { id: makeId() });
    ops.push({ kind: "create", id: copy.id, task: copy });
  });

  const union = (a, b, cap) => {
    const out = (Array.isArray(a) ? a : []).slice();
    (Array.isArray(b) ? b : []).forEach((value) => {
      if (out.indexOf(value) < 0) out.push(value);
    });
    return out.length > cap ? out.slice(-cap) : out;
  };
  const goals = union(existingProfile.goals, incoming.profile.goals, MAX_GOALS);
  const habits = union(existingProfile.habits, incoming.profile.habits, MAX_HABITS);
  ops.push({ kind: "profile", profile: { goals, habits } });

  return { ops, mode, added: incoming.tasks.length, removed: 0 };
}
