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
  cancelled: ""
};

export function errorCopy(code) {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code];
  return "Something went wrong reaching Claude. Try again.";
}
