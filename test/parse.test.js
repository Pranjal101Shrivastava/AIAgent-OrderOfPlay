import test from "node:test";
import assert from "node:assert/strict";

import {
  DB_ERROR_COPY,
  ERROR_COPY,
  REPLY_FALLBACK,
  dbErrorCopy,
  describeWriteFailures,
  errorCopy,
  parseLoose,
  readAgentReply
} from "../src/core/parse.js";

test("parseLoose reads plain JSON", () => {
  assert.deepEqual(parseLoose('{"reply":"ok","actions":[]}'), { reply: "ok", actions: [] });
  assert.deepEqual(parseLoose("  [1,2]  "), [1, 2]);
});

test("parseLoose unwraps a fenced block", () => {
  assert.deepEqual(parseLoose('```json\n{"reply":"hi","actions":[]}\n```'), {
    reply: "hi",
    actions: []
  });
  assert.deepEqual(parseLoose('```\n{"a":1}\n```'), { a: 1 });
});

test("parseLoose recovers JSON buried in prose", () => {
  const raw = 'Sure, here is the plan:\n{"reply":"Moved it.","actions":[]}\nLet me know!';
  assert.deepEqual(parseLoose(raw), { reply: "Moved it.", actions: [] });
});

test("parseLoose handles a fence with a leading sentence", () => {
  const raw = 'Happy to help.\n\n```json\n{"reply":"done","actions":[]}\n```\n\nAnything else?';
  assert.deepEqual(parseLoose(raw), { reply: "done", actions: [] });
});

test("parseLoose returns null rather than throwing", () => {
  assert.equal(parseLoose(""), null);
  assert.equal(parseLoose("   "), null);
  assert.equal(parseLoose(null), null);
  assert.equal(parseLoose(undefined), null);
  assert.equal(parseLoose("I cannot help with that."), null);
  assert.equal(parseLoose("{not json at all"), null);
  assert.equal(parseLoose("{{{"), null);
});

test("parseLoose keeps nested braces intact", () => {
  const raw = 'text {"reply":"a {b} c","actions":[{"op":"add","title":"x"}]} tail';
  assert.deepEqual(parseLoose(raw).actions, [{ op: "add", title: "x" }]);
});

test("readAgentReply accepts a well-formed turn", () => {
  const out = readAgentReply('{"reply":"Moved it.","actions":[{"op":"done","id":"a"}]}');
  assert.equal(out.ok, true);
  assert.equal(out.reply, "Moved it.");
  assert.deepEqual(out.actions, [{ op: "done", id: "a" }]);
  assert.equal(out.error, "");
});

test("readAgentReply treats no actions as a conversational turn", () => {
  const out = readAgentReply('{"reply":"Nothing to change."}');
  assert.equal(out.ok, true);
  assert.deepEqual(out.actions, []);
});

test("readAgentReply supplies a fallback reply", () => {
  assert.equal(readAgentReply('{"actions":[]}').reply, REPLY_FALLBACK);
  assert.equal(readAgentReply('{"reply":"   ","actions":[]}').reply, REPLY_FALLBACK);
  assert.equal(readAgentReply('{"reply":42,"actions":[]}').reply, REPLY_FALLBACK);
});

test("readAgentReply is not ok when nothing parses", () => {
  const out = readAgentReply("I refuse.");
  assert.equal(out.ok, false);
  assert.match(out.error, /no JSON/);
  assert.deepEqual(out.actions, []);
});

test("readAgentReply rejects a bare array", () => {
  const out = readAgentReply('[{"op":"done","id":"a"}]');
  assert.equal(out.ok, false, "the contract is an object, not an action list");
  assert.match(out.error, /not a JSON object/);
});

test("readAgentReply keeps the reply when actions are the wrong type", () => {
  const out = readAgentReply('{"reply":"Here you go","actions":"do everything"}');
  assert.equal(out.ok, true);
  assert.equal(out.reply, "Here you go");
  assert.deepEqual(out.actions, [], "a malformed action list applies nothing");
  assert.match(out.error, /not an array/);
});

test("readAgentReply trims the reply", () => {
  assert.equal(readAgentReply('{"reply":"  spaced  ","actions":[]}').reply, "spaced");
});

test("errorCopy branches on codes, never on message text", () => {
  assert.equal(errorCopy("rate_limited"), ERROR_COPY.rate_limited);
  assert.equal(errorCopy("cancelled"), "", "a user cancellation says nothing");
  assert.match(errorCopy("some_new_code"), /Something went wrong/);
  assert.match(errorCopy(undefined), /Something went wrong/);
});

test("errorCopy does not leak inherited properties", () => {
  assert.match(errorCopy("toString"), /Something went wrong/);
  assert.match(errorCopy("__proto__"), /Something went wrong/);
});

// --- storage failures ------------------------------------------------------

test("dbErrorCopy names each storage failure the store can raise", () => {
  assert.equal(dbErrorCopy("quota_exceeded"), DB_ERROR_COPY.quota_exceeded);
  assert.match(dbErrorCopy("invalid_argument"), /malformed/);
  assert.match(dbErrorCopy("revoked"), /Reload/);
  assert.match(dbErrorCopy("unavailable"), /wasn't saved/);
});

test("dbErrorCopy does not leak inherited properties", () => {
  assert.match(dbErrorCopy("toString"), /couldn't be saved/);
  assert.match(dbErrorCopy("__proto__"), /couldn't be saved/);
  assert.match(dbErrorCopy("some_future_code"), /couldn't be saved/);
  assert.match(dbErrorCopy(undefined), /couldn't be saved/);
});

test("describeWriteFailures is silent when nothing failed", () => {
  assert.equal(describeWriteFailures([]), "");
  assert.equal(describeWriteFailures(null), "");
  assert.equal(describeWriteFailures(undefined), "");
});

test("describeWriteFailures reports the count and the reason", () => {
  const one = describeWriteFailures([{ kind: "create", id: "a", code: "quota_exceeded" }]);
  assert.match(one, /storage limit/);
  assert.match(one, /1 change lost/);

  const many = describeWriteFailures([
    { kind: "create", id: "a", code: "unavailable" },
    { kind: "patch", id: "b", code: "unavailable" }
  ]);
  assert.match(many, /2 changes lost/);
  assert.match(many, /temporarily unreachable/, "one shared code names that code");
});

test("describeWriteFailures generalises when codes differ", () => {
  const mixed = describeWriteFailures([
    { kind: "create", id: "a", code: "quota_exceeded" },
    { kind: "patch", id: "b", code: "invalid_argument" }
  ]);
  assert.match(mixed, /Some changes couldn't be saved/);
  assert.match(mixed, /2 changes lost/);
});

test("describeWriteFailures survives a failure with no code", () => {
  const out = describeWriteFailures([{ kind: "create", id: "a" }]);
  assert.match(out, /couldn't be saved/);
  assert.match(out, /1 change lost/);
});
