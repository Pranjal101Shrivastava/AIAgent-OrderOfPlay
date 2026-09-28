/**
 * Reading a model's reply as if it were a wire protocol, which it is not.
 *
 * The prompt asks for raw JSON and nothing else. That instruction is followed
 * most of the time, and "most of the time" is not a contract. Replies arrive
 * fenced in markdown, prefixed with a sentence of agreement, or occasionally
 * with a trailing explanation. A parser that only accepts the specified format
 * turns each of those into a failed turn and a lost plan.
 *
 * So the reader is deliberately tolerant about framing and strict about
 * content. It will hunt for the JSON, and then refuse to guess at what it
 * finds: a reply whose `actions` is not an array is an error, not something to
 * be coerced into one.
 */

/**
 * Three attempts, cheapest first: the whole string, a fenced block, then the
 * outermost brace or bracket span. Returns null when nothing parses, and never
 * throws.
 */
export function parseLoose(raw) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (err) {
    /* not bare JSON */
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (err) {
      /* fence held something else */
    }
  }

  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (err) {
      /* give up */
    }
  }
  return null;
}

export const REPLY_FALLBACK = "Done.";

/**
 * Parse and shape-check one agent turn.
 *
 * @returns {{ok: boolean, reply: string, actions: Array, error: string}}
 *   `ok` false means nothing should be written. A reply that parses but carries
 *   no actions is a legitimate conversational turn, not a failure.
 */
export function readAgentReply(raw) {
  const parsed = parseLoose(raw);
  if (parsed === null) {
    return { ok: false, reply: "", actions: [], error: "no JSON found in the reply" };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reply: "", actions: [], error: "reply was not a JSON object" };
  }

  const reply =
    typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : REPLY_FALLBACK;

  if (parsed.actions === undefined || parsed.actions === null) {
    return { ok: true, reply, actions: [], error: "" };
  }
  if (!Array.isArray(parsed.actions)) {
    return { ok: true, reply, actions: [], error: "actions was not an array; none applied" };
  }
  return { ok: true, reply, actions: parsed.actions, error: "" };
}

/**
 * Error codes the host's sampling capability raises, mapped to copy.
 *
 * Branching on a stable code rather than on message text is what keeps this
 * from breaking when the host rewords something. An unmapped code gets generic
 * copy rather than leaking an internal string into the interface.
 */
export const ERROR_COPY = {
  not_granted: "You'll need to allow this page to use Claude before I can help.",
  sampling_disabled: "Claude isn't available on this account right now.",
  rate_limited: "You've hit your Claude usage limit — try again in a bit.",
  session_expired: "Your session expired. Sign in again and resend.",
  invalid_json: "I garbled that one. Say it again?",
  refused: "I can't act on that one.",
  empty_completion: "I came back blank. Try saying it a different way.",
  prompt_too_large: "Too much at once — clear some finished tasks first.",
  cancelled: "",

  // The codes the first version left unmapped. Every one of them fell through
  // to the generic line, which is how a persistent failure stayed
  // indistinguishable from a passing blip for a week.
  upstream_error: "Claude didn't answer that time. It's usually temporary — try again.",
  not_declared: "This page isn't set up to use Claude. It needs republishing with the sample capability.",
  capability_disabled: "Claude isn't usable in this view. Try opening the page directly.",
  capability_removed: "This page needs republishing to work with the current viewer.",
  invalid_request: "I built that request wrongly — this is a bug in the page, not something you did.",
  transform_error: "I built that request wrongly — this is a bug in the page, not something you did.",
  queue_overflow: "Too many requests stacked up. Reload the page.",
  images_unavailable: "This view can't send images.",
  tools_unavailable: "This view can't run page tools.",
  image_rejected: "That image couldn't be used."
};

export function errorCopy(code) {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code];
  return "Something went wrong reaching Claude. Try again.";
}

/**
 * Storage error codes, mapped to copy.
 *
 * These arrive from the document store rather than the sampling capability, but
 * the rule is the same one: branch on a stable code, never on message text, and
 * give an unknown code generic copy rather than leaking an internal string.
 *
 * This exists because the first version swallowed every storage failure. A
 * write that failed left the task on screen — the page had already applied it
 * locally — until the next snapshot arrived without it and it vanished. No
 * message, no code, nothing to report. A tool that cannot say why it failed is
 * worse than one that fails loudly, and it makes the failure undiagnosable from
 * the outside.
 */
export const DB_ERROR_COPY = {
  invalid_argument: "That change was rejected as malformed and wasn't saved.",
  resource_exhausted: "Too many changes at once — wait a moment and try again.",
  quota_exceeded: "This queue has hit its storage limit. Delete some finished tasks.",
  unavailable: "Storage is temporarily unreachable. Your change wasn't saved.",
  revoked: "This page lost access to its storage. Reload to sign in again.",
  not_granted: "This page isn't allowed to save data here.",
  capability_disabled: "Saving isn't available in this view.",
  capability_removed: "Saving isn't available in this view.",
  transform_error: "That change couldn't be prepared and wasn't saved."
};

export function dbErrorCopy(code) {
  if (code && Object.prototype.hasOwnProperty.call(DB_ERROR_COPY, code)) {
    return DB_ERROR_COPY[code];
  }
  return "That change couldn't be saved.";
}

/**
 * One line describing what failed to save, for the status line.
 *
 * Names the count rather than every id: the user needs to know their change did
 * not stick and roughly why, not a list of document paths.
 */
export function describeWriteFailures(failures) {
  if (!failures || !failures.length) return "";
  const codes = Array.from(new Set(failures.map((f) => f.code).filter(Boolean)));
  const copy = codes.length === 1 ? dbErrorCopy(codes[0]) : "Some changes couldn't be saved.";
  const n = failures.length;
  return `${copy} (${n} change${n === 1 ? "" : "s"} lost — reload to see what was stored.)`;
}
