/**
 * Day arithmetic for a queue that has days but no hours.
 *
 * Every day in this system is either an ISO calendar day ("2026-09-26") or the
 * literal "someday". There is no time field anywhere in the schema, so all of
 * this is string math over calendar days rather than arithmetic on Date objects
 * carrying an offset. That distinction is the whole point: a Date is a moment,
 * and a moment belongs to two different calendar days depending on where you
 * are standing. A task belongs to a day.
 */

export const SOMEDAY = "someday";
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * True only for a real calendar day. The regex alone is not enough: it happily
 * accepts "2026-13-45", so the parts are round-tripped through a UTC date and
 * compared back. February 30th fails here, as it should.
 */
export function isIsoDay(value) {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** True for anything the schema accepts in a `day` field. */
export function isDayKey(value) {
  return value === SOMEDAY || isIsoDay(value);
}

/** The browser's own idea of today. Used only as a fallback. */
export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Today, as it reads on the wall in `timeZone`.
 *
 * This is the fix for the travel bug. `localDay` asks the browser, which means
 * boarding a flight silently rewrites which day "today" is and files tasks
 * against the wrong one. Anchoring to a stored home zone makes the queue stable
 * while the traveller is not.
 *
 * Unknown or unsupported zones fall back to local rather than throwing, because
 * a bad stored preference must not be able to break the whole page.
 */
export function todayIn(timeZone, now = new Date()) {
  if (typeof timeZone === "string" && timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(now);
      const pick = (type) => {
        const hit = parts.find((p) => p.type === type);
        return hit ? hit.value : "";
      };
      const key = `${pick("year")}-${pick("month")}-${pick("day")}`;
      if (isIsoDay(key)) return key;
    } catch (err) {
      /* unknown zone: fall through to local */
    }
  }
  return localDay(now);
}

/** The zone this environment thinks it is in, or "" if it will not say. */
export function resolveZone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (err) {
    return "";
  }
}

export function isValidZone(zone) {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Shift a calendar day by whole days. "someday" is a fixed point — it has no
 * position on the calendar, so nothing can be added to it.
 */
export function addDays(dayKey, n) {
  if (!isIsoDay(dayKey)) return dayKey;
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  const shifted = new Date(Date.UTC(year, month - 1, day) + n * 86400000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate()
  )}`;
}

/**
 * Chronological order, with "someday" sorting after every dated day.
 *
 * That ordering is what makes push detection a one-liner: deferring to
 * "someday" is the furthest deferral there is, and pulling a task from
 * "someday" onto a real day is never a deferral.
 */
export function compareDays(a, b) {
  if (a === b) return 0;
  if (a === SOMEDAY) return 1;
  if (b === SOMEDAY) return -1;
  return a < b ? -1 : 1;
}

export function isBefore(a, b) {
  return compareDays(a, b) < 0;
}

export function isAfter(a, b) {
  return compareDays(a, b) > 0;
}

/** Whole days from `a` to `b`, or null when either side is not a dated day. */
export function daysBetween(a, b) {
  if (!isIsoDay(a) || !isIsoDay(b)) return null;
  const at = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const bt = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((bt - at) / 86400000);
}

/** A dated day is overdue when it is strictly before today. "someday" never is. */
export function isOverdue(dayKey, today) {
  return isIsoDay(dayKey) && isIsoDay(today) && dayKey < today;
}

/**
 * "Fri 26 Sep" for a dated day, "" for someday. Noon is used to build the Date
 * so that a viewer west of UTC cannot see the label slip to the previous day.
 */
export function prettyDay(dayKey, locale) {
  if (dayKey === SOMEDAY) return "";
  if (!isIsoDay(dayKey)) return String(dayKey);
  const at = new Date(`${dayKey}T12:00:00`);
  if (Number.isNaN(at.getTime())) return dayKey;
  try {
    return at.toLocaleDateString(locale || undefined, {
      weekday: "short",
      day: "numeric",
      month: "short"
    });
  } catch (err) {
    return dayKey;
  }
}
