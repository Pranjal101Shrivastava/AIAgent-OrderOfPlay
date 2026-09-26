import test from "node:test";
import assert from "node:assert/strict";

import {
  SOMEDAY,
  addDays,
  compareDays,
  daysBetween,
  isAfter,
  isBefore,
  isDayKey,
  isIsoDay,
  isOverdue,
  localDay,
  prettyDay,
  todayIn
} from "../src/core/day.js";

test("isIsoDay accepts real calendar days", () => {
  assert.equal(isIsoDay("2026-09-26"), true);
  assert.equal(isIsoDay("2024-02-29"), true, "2024 is a leap year");
  assert.equal(isIsoDay("2026-01-01"), true);
});

test("isIsoDay rejects what the regex alone would let through", () => {
  assert.equal(isIsoDay("2026-13-01"), false, "month 13");
  assert.equal(isIsoDay("2026-02-30"), false, "February 30th");
  assert.equal(isIsoDay("2025-02-29"), false, "2025 is not a leap year");
  assert.equal(isIsoDay("2026-00-10"), false, "month zero");
  assert.equal(isIsoDay("2026-09-00"), false, "day zero");
  assert.equal(isIsoDay("2026-9-26"), false, "unpadded");
  assert.equal(isIsoDay("26-09-2026"), false, "wrong order");
  assert.equal(isIsoDay(SOMEDAY), false);
  assert.equal(isIsoDay(""), false);
  assert.equal(isIsoDay(null), false);
  assert.equal(isIsoDay(20260926), false, "numbers are not day keys");
});

test("isDayKey is isIsoDay plus the someday literal", () => {
  assert.equal(isDayKey(SOMEDAY), true);
  assert.equal(isDayKey("2026-09-26"), true);
  assert.equal(isDayKey("later"), false);
  assert.equal(isDayKey("Someday"), false, "case matters");
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-09-26", 1), "2026-09-27");
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2025-02-28", 1), "2025-03-01");
  assert.equal(addDays("2026-09-26", 0), "2026-09-26");
  assert.equal(addDays("2026-09-26", 365), "2027-09-26");
});

test("someday is a fixed point under addDays", () => {
  assert.equal(addDays(SOMEDAY, 1), SOMEDAY);
  assert.equal(addDays(SOMEDAY, -40), SOMEDAY);
  assert.equal(addDays("not a day", 1), "not a day");
});

test("compareDays sorts someday after every dated day", () => {
  assert.equal(compareDays("2026-09-26", "2026-09-27"), -1);
  assert.equal(compareDays("2026-09-27", "2026-09-26"), 1);
  assert.equal(compareDays("2026-09-26", "2026-09-26"), 0);
  assert.equal(compareDays("2099-12-31", SOMEDAY), -1, "someday is beyond any date");
  assert.equal(compareDays(SOMEDAY, "1999-01-01"), 1);
  assert.equal(compareDays(SOMEDAY, SOMEDAY), 0);
});

test("isAfter encodes deferral, which is what the push counter needs", () => {
  assert.equal(isAfter("2026-09-27", "2026-09-26"), true, "later day is a deferral");
  assert.equal(isAfter("2026-09-25", "2026-09-26"), false, "earlier day is not");
  assert.equal(isAfter(SOMEDAY, "2026-09-26"), true, "someday is the furthest deferral");
  assert.equal(isAfter("2026-09-26", SOMEDAY), false, "pulling off someday is not a deferral");
  assert.equal(isBefore("2026-09-25", "2026-09-26"), true);
});

test("daysBetween is signed and null for someday", () => {
  assert.equal(daysBetween("2026-09-26", "2026-09-29"), 3);
  assert.equal(daysBetween("2026-09-29", "2026-09-26"), -3);
  assert.equal(daysBetween("2026-09-26", "2026-09-26"), 0);
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(daysBetween(SOMEDAY, "2026-09-26"), null);
  assert.equal(daysBetween("2026-09-26", SOMEDAY), null);
});

test("isOverdue is strictly before today and never someday", () => {
  assert.equal(isOverdue("2026-09-25", "2026-09-26"), true);
  assert.equal(isOverdue("2026-09-26", "2026-09-26"), false, "today is not overdue");
  assert.equal(isOverdue("2026-09-27", "2026-09-26"), false);
  assert.equal(isOverdue(SOMEDAY, "2026-09-26"), false, "someday can never be late");
});

test("todayIn anchors to a zone instead of the host offset", () => {
  // 2026-09-26T04:00Z is still the 25th in Los Angeles and already the 26th in
  // Kolkata. This is the exact case that misfiled tasks before the fix.
  const moment = new Date("2026-09-26T04:00:00Z");
  assert.equal(todayIn("Asia/Kolkata", moment), "2026-09-26");
  assert.equal(todayIn("America/Los_Angeles", moment), "2026-09-25");
  assert.equal(todayIn("UTC", moment), "2026-09-26");
});

test("todayIn crosses the year boundary per zone", () => {
  const nearMidnight = new Date("2027-01-01T02:00:00Z");
  assert.equal(todayIn("UTC", nearMidnight), "2027-01-01");
  assert.equal(todayIn("America/New_York", nearMidnight), "2026-12-31");
});

test("todayIn falls back to local rather than throwing on a bad zone", () => {
  const moment = new Date("2026-09-26T12:00:00Z");
  assert.equal(todayIn("Mars/Olympus_Mons", moment), localDay(moment));
  assert.equal(todayIn("", moment), localDay(moment));
  assert.equal(todayIn(null, moment), localDay(moment));
});

test("localDay pads single digits", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 12)), "2026-01-05");
  assert.equal(localDay(new Date(2026, 11, 31, 12)), "2026-12-31");
});

test("prettyDay is empty for someday and passes through junk", () => {
  assert.equal(prettyDay(SOMEDAY), "");
  assert.equal(prettyDay("nonsense"), "nonsense");
  assert.match(prettyDay("2026-09-26", "en-US"), /Sep/);
});
