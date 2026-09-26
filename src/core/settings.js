/**
 * The few preferences that have to outlive a browser.
 *
 * Tier selection lives in `localStorage`, because it is a per-device
 * convenience and losing it costs nothing. These do not: a home timezone and a
 * rollover policy change what the agent computes, so they belong in the store
 * next to the data they affect, and they have to follow the user across
 * devices. A queue that rolls over on the laptop and not on the phone is worse
 * than one that never rolls over at all.
 */

import { isValidZone, resolveZone } from "./day.js";
import { ROLLOVER_ASK, coerceRolloverMode } from "./rollover.js";

export const DEFAULT_SETTINGS = {
  timeZone: "",
  rollover: ROLLOVER_ASK
};

/**
 * Read settings out of a stored profile document.
 *
 * An empty `timeZone` means "follow this device", which is the right default:
 * it is correct for the majority who never travel, and it is honest about the
 * fact that nobody has told us otherwise. A stored zone the platform no longer
 * recognises is discarded rather than kept, so an ICU update cannot strand the
 * queue on a zone that resolves to nothing.
 */
export function readSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const zone = typeof src.timeZone === "string" && isValidZone(src.timeZone) ? src.timeZone : "";
  return {
    timeZone: zone,
    rollover: coerceRolloverMode(src.rollover)
  };
}

/** The effective zone: the stored preference, else whatever the device says. */
export function effectiveZone(settings) {
  const stored = settings && settings.timeZone;
  if (typeof stored === "string" && stored && isValidZone(stored)) return stored;
  return resolveZone();
}

export function withSetting(settings, key, value) {
  const next = Object.assign({}, readSettings(settings));
  if (key === "timeZone") {
    next.timeZone = typeof value === "string" && isValidZone(value) ? value : "";
  } else if (key === "rollover") {
    next.rollover = coerceRolloverMode(value);
  }
  return next;
}

/** A short list of zones to offer without asking anyone to type an IANA name. */
export function zoneChoices(current) {
  const base = [
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney"
  ].filter(isValidZone);
  const device = resolveZone();
  const out = [];
  if (device && base.indexOf(device) < 0) out.push(device);
  if (current && current !== device && base.indexOf(current) < 0 && isValidZone(current)) {
    out.push(current);
  }
  return out.concat(base);
}
