import test from "node:test";
import assert from "node:assert/strict";

import { resolveZone } from "../src/core/day.js";
import { ROLLOVER_ASK, ROLLOVER_AUTO, ROLLOVER_OFF } from "../src/core/rollover.js";
import { DEFAULT_SETTINGS, effectiveZone, readSettings, withSetting, zoneChoices } from "../src/core/settings.js";

test("readSettings defaults to following the device and asking", () => {
  assert.deepEqual(readSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({}), { timeZone: "", rollover: ROLLOVER_ASK });
});

test("readSettings keeps a valid zone and discards a dead one", () => {
  assert.equal(readSettings({ timeZone: "Asia/Kolkata" }).timeZone, "Asia/Kolkata");
  assert.equal(readSettings({ timeZone: "Mars/Olympus_Mons" }).timeZone, "");
  assert.equal(readSettings({ timeZone: 42 }).timeZone, "");
});

test("readSettings validates the rollover mode", () => {
  assert.equal(readSettings({ rollover: ROLLOVER_AUTO }).rollover, ROLLOVER_AUTO);
  assert.equal(readSettings({ rollover: ROLLOVER_OFF }).rollover, ROLLOVER_OFF);
  assert.equal(readSettings({ rollover: "sometimes" }).rollover, ROLLOVER_ASK);
});

test("effectiveZone prefers the stored preference over the device", () => {
  assert.equal(effectiveZone({ timeZone: "Asia/Kolkata" }), "Asia/Kolkata");
  assert.equal(effectiveZone({ timeZone: "" }), resolveZone(), "empty means follow the device");
  assert.equal(effectiveZone({ timeZone: "Nowhere/Nothing" }), resolveZone());
  assert.equal(effectiveZone(null), resolveZone());
});

test("withSetting returns a new object and never stores junk", () => {
  const base = readSettings({});
  const next = withSetting(base, "timeZone", "Europe/London");
  assert.equal(next.timeZone, "Europe/London");
  assert.equal(base.timeZone, "", "the original is untouched");
  assert.equal(withSetting(base, "timeZone", "Not/AZone").timeZone, "");
  assert.equal(withSetting(base, "rollover", ROLLOVER_AUTO).rollover, ROLLOVER_AUTO);
  assert.equal(withSetting(base, "rollover", "nonsense").rollover, ROLLOVER_ASK);
});

test("withSetting ignores an unknown key", () => {
  const next = withSetting(readSettings({}), "somethingElse", "value");
  assert.deepEqual(next, DEFAULT_SETTINGS);
});

test("zoneChoices offers real zones and includes the device's own", () => {
  const choices = zoneChoices("");
  assert.ok(choices.length > 5);
  assert.equal(new Set(choices).size, choices.length, "no duplicates");
  const device = resolveZone();
  if (device) assert.ok(choices.includes(device));
});

test("zoneChoices surfaces a stored zone that is not in the default list", () => {
  const choices = zoneChoices("Pacific/Auckland");
  assert.ok(choices.includes("Pacific/Auckland"));
});
