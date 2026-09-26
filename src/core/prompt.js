/**
 * Assembling the turn.
 *
 * The model is memoryless between calls, so every turn ships the whole world:
 * the rules, today's date, the goals, the learned habits, every open task with
 * its id, and a slice of recent history. This looks wasteful and is the right
 * shape — the store stays the single source of truth, and there is no drift
 * between what the model believes the queue is and what it is.
 *
 * It lives in its own module because a prompt is program logic. Buried in a
 * template literal inside an event handler, a behavioural rule cannot be tested,
 * diffed meaningfully, or reviewed without reading the UI. Here, the contract it
 * promises the parser is asserted in the test suite alongside everything else.
 */

import { SOMEDAY, addDays } from "./day.js";
import { PUSH_ALARM } from "./actions.js";
import { findOverdue } from "./rollover.js";
import { isOpen } from "./task.js";

export const PROMPT_BUDGET = 64 * 1024;
export const HISTORY_LINES = 12;

function taskLine(task) {
  return [
    `- id=${task.id}`,
    `"${task.title}"`,
    `day=${task.day}`,
    `shape=${task.shape}`,
    `size=${task.size}`,
    `order=${task.order || 0}`,
    `pushed=${task.pushes || 0}x`
  ].join(" | ");
}

/**
 * Build the full prompt for one user message.
 *
 * @param {Object} input { message, tasks, profile, log, today, name }
 */
export function buildPrompt(input) {
  const src = input || {};
  const today = src.today;
  const tomorrow = addDays(today, 1);
  const name = typeof src.name === "string" && src.name.trim() ? src.name.trim() : "the user";
  const tasks = Array.isArray(src.tasks) ? src.tasks : [];
  const profile = src.profile && typeof src.profile === "object" ? src.profile : {};
  const goals = Array.isArray(profile.goals) ? profile.goals : [];
  const habits = Array.isArray(profile.habits) ? profile.habits : [];
  const log = Array.isArray(src.log) ? src.log : [];

  const open = tasks.filter(isOpen);
  const overdue = findOverdue(tasks, { today });

  const openLines = open.length ? open.map(taskLine).join("\n") : "(none)";
  const overdueLines = overdue.length
    ? overdue.map((t) => `- id=${t.id} | "${t.title}" | was due ${t.day}`).join("\n")
    : "(none)";
  const history = log.length
    ? log
        .slice(-HISTORY_LINES)
        .map((entry) => `- ${String(entry.ts || "").slice(0, 10)}: ${entry.text || ""}`)
        .join("\n")
    : "(none)";
  const chronic = open.filter((t) => (t.pushes || 0) >= PUSH_ALARM);

  return [
    `You are ${name}'s personal secretary. You run a task queue, not a calendar.`,
    "",
    "HARD RULES",
    "- Never assign clock times. Days are fixed; hours are theirs to choose. You only ever change the ORDER of tasks within a day.",
    "- If they say they are tired, hungry, low or busy, do not argue. Put something lighter next and move the heavy thing later in the day or to another day.",
    `- Moving a task to a later day is a push. If a task has been pushed ${PUSH_ALARM} or more times, say so plainly and ask what is actually blocking it. Do not let it slide again in silence.`,
    "- Work listed as OVERDUE has already had a day pass without being done. Deal with it explicitly: either move it onto a real day or ask whether it should be dropped. Never leave it unmentioned.",
    "- Protect their goals from their moods, warmly. You are a secretary: not a cheerleader, not a nag.",
    "- When you learn something durable about how they work (an energy rhythm, a preference, a pattern), record it with a habit action. Durable patterns only, never a one-off mood.",
    "- Keep the reply to at most two sentences. Plain, warm, specific. No lists, no emoji.",
    "",
    `TODAY IS ${today}. Tomorrow is ${tomorrow}.`,
    "",
    "THEIR GOALS",
    goals.length ? goals.map((g) => `- ${g}`).join("\n") : "(none recorded yet)",
    "",
    "WHAT YOU HAVE LEARNED ABOUT THEM",
    habits.length ? habits.map((h) => `- ${h}`).join("\n") : "(nothing yet)",
    "",
    "OVERDUE — a day has already passed on these",
    overdueLines,
    "",
    "ALL OPEN TASKS",
    openLines,
    "",
    chronic.length
      ? `CHRONICALLY AVOIDED (pushed ${PUSH_ALARM}+ times)\n` +
        chronic.map((t) => `- id=${t.id} | "${t.title}" | pushed ${t.pushes}x`).join("\n")
      : "CHRONICALLY AVOIDED\n(none)",
    "",
    "RECENT HISTORY",
    history,
    "",
    "THEIR MESSAGE",
    String(src.message === undefined || src.message === null ? "" : src.message),
    "",
    'Reply with ONLY a JSON object: {"reply":"...","actions":[...]}',
    "Output raw JSON and nothing else: no prose before or after it, no markdown code fences.",
    "Each action is exactly one of:",
    '{"op":"add","title":"...","day":"YYYY-MM-DD or someday","shape":"deep|admin|errand|social","size":"S|M|L"}',
    '{"op":"order","day":"YYYY-MM-DD","ids":["id","id"]}   (the full new order for that day)',
    '{"op":"move","id":"...","day":"YYYY-MM-DD or someday"}',
    '{"op":"done","id":"..."}',
    '{"op":"drop","id":"..."}',
    '{"op":"habit","text":"..."}',
    '{"op":"goal","text":"..."}',
    "Only use ids that appear above. An order action must list ids already on that day.",
    "Use an empty actions array when nothing should change.",
    `Example: {"reply":"Moved the write-up to tomorrow. The email thread is next, it is lighter.","actions":[{"op":"move","id":"a1","day":"${tomorrow}"},{"op":"order","day":"${today}","ids":["b2","c3"]}]}`
  ].join("\n");
}

/**
 * Whether a prompt will fit the host's per-call limit.
 *
 * Measured in UTF-8 bytes rather than characters, because the limit is a byte
 * limit and a queue full of non-Latin titles would otherwise pass this check
 * and fail the call.
 */
export function promptFits(prompt, budget) {
  const cap = Number.isFinite(budget) ? budget : PROMPT_BUDGET;
  const bytes =
    typeof TextEncoder === "function"
      ? new TextEncoder().encode(prompt).length
      : Buffer.byteLength(prompt, "utf8");
  return { bytes, cap, fits: bytes <= cap };
}

/** Rough guidance when the prompt is too large to send. */
export function trimAdvice(tasks) {
  const done = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.status === "done").length;
  const someday = (Array.isArray(tasks) ? tasks : []).filter(
    (t) => t && t.day === SOMEDAY && isOpen(t)
  ).length;
  if (done > 20) return `Clear some of the ${done} completed tasks and try again.`;
  if (someday > 40) return `The Someday list has ${someday} items — prune it and try again.`;
  return "Too much at once — clear some finished tasks first.";
}
