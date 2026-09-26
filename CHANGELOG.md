# Changelog

All notable changes to Order of Play.

This project uses [Semantic Versioning](https://semver.org/). Dates are ISO calendar days,
which is also how the app stores them.

---

## [1.1.0] — 2026-09-26

The release that makes it a product rather than a prototype: a real test suite, a build that
keeps the single-file deployment target, and the correctness fixes that testing surfaced.

### Fixed

- **Overdue tasks were displayed as upcoming.** The day router tested equality against today,
  tomorrow and `someday`, with everything else falling through to "Later this week" — so a
  task from last Tuesday was presented as future work. For a tool built to notice avoidance,
  this hid exactly the tasks most likely to be avoided. There is now an explicit **Overdue**
  section, sorted oldest-debt-first.
- **`isIsoDay` accepted impossible dates.** `/^\d{4}-\d{2}-\d{2}$/` looks like date validation
  and accepts `2026-02-30` and `2026-13-01`. Day strings are now round-tripped through a real
  calendar date.
- **"Today" followed the device, not the user.** Travelling rewrote which day was today and
  misfiled work. Days are now anchored to a stored home timezone, with the device as fallback.
- **Refused actions were dropped in silence.** A user could be told a plan had been applied
  while part of it had been rejected. Every refusal is now surfaced.
- **`order` could relocate a task.** An `order` action naming an id from another day moved it.
  Ids not already open on that day are now refused.
- **An open task could carry a completion timestamp.** The normaliser now clears `doneAt`
  whenever status is `open`, so the contradiction is unrepresentable.
- **`errorCopy` could return inherited object properties.** A code of `toString` returned a
  JavaScript function. Lookups are now guarded with `hasOwnProperty`.

### Added

- **Undo and redo** over agent plans, manual edits and rollover, via `Cmd/Ctrl+Z` or the
  toolbar. Implemented as snapshot-and-diff rather than inverse operations, and applied
  through the same executor as every other write.
- **Inline task editing** — rename, reshape, resize, re-day or delete without a model call.
  A manual move to a later day counts a push, exactly as the agent's would.
- **Overdue rollover**, with a fairness rule: a task can be charged at most one rollover push
  per calendar day, tracked in a new `rolledAt` field, so a week away costs one push rather
  than seven. Never silent — it is either requested or enabled in settings.
- **Versioned JSON export and import**, with replace and merge modes. Import validates every
  row through the running app's own normaliser and repairs what it can, reporting each repair
  rather than failing the whole file.
- **Settings**: home timezone and rollover policy, stored server-side so they follow the user
  across devices rather than living in `localStorage`.
- **Client-assigned task ids**, so an `add` and an `order` in the same batch can cooperate.
- **Prompt improvements**: a dedicated overdue section, a chronically-avoided section, and a
  rule requiring the agent to address overdue work explicitly.
- **Prompt size budgeting** measured in UTF-8 bytes rather than characters, with specific
  advice about what to prune when a queue outgrows the limit.

### Changed

- **Restructured into testable modules.** Pure domain logic moved from a single 686-line HTML
  file into `src/core/*.js` as real ES modules. `build.mjs` inlines them into
  `src/shell.html` to produce `dist/order-of-play.html` — still one self-contained file to
  publish, committed so publishing needs no build step.
- **`src/order-of-play.html` is gone.** The publishable artifact is now
  `dist/order-of-play.html`; the editable interface source is `src/shell.html`.
- The action layer is now pure: no IO, no clock, no randomness except an injected id factory.
  This is what makes it testable.
- Habit and goal text is normalised before the duplicate check, so whitespace variations no
  longer register as new observations.

### Testing and infrastructure

- **161 assertions** via `node:test`, covering every coercion with hostile input, every action
  valid and invalid, the push rule in all four directions, rollover fairness, undo and redo,
  the tolerant parser, backup round-trips, and the prompt itself — including a test that the
  worked example shown to the model parses with this project's own parser.
- **A build-linkage test** that cross-references every identifier the shell calls against the
  core's real exports, so a typo'd core call fails CI. Verified by introducing a deliberate
  typo and confirming it was caught.
- **35 browser checks** driving the built artifact in Chromium: degraded mode with no
  capabilities, the full agent path with a scripted reply (fenced, prose-wrapped, carrying a
  bogus action), editing, rollover, undo, settings, and mobile layout.
- **CI on Node 20 and 22**, which also asserts `dist/` is in sync with `src/` and that no npm
  dependencies have crept in.

### Notes

The `complex` model tier remains unreachable in code, and there is now a test asserting the
string never appears in a request in the built file.

---

## [1.0.0] — 2026-09-19

Initial release.

- Queue-based task model: tasks belong to a day and have an order, never a start time.
- Seven-op action whitelist between the model and storage.
- Push counter, with the agent instructed to call out a task pushed three or more times.
- Shape (`deep` / `admin` / `errand` / `social`) and size (`S` / `M` / `L`).
- Profile of stated goals and learned habits, fed into every prompt.
- Bounded event log, last twelve lines included as context.
- Model tier selector with the top tier disabled in code.
- Graceful degradation when runtime capabilities are absent.
