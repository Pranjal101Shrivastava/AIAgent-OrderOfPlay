import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "order-of-play.html");

const dist = await readFile(DIST, "utf8");

function inlineScript(html) {
  const start = html.lastIndexOf("<script>");
  const end = html.lastIndexOf("</script>");
  assert.ok(start >= 0 && end > start, "the artifact has an inline script");
  return html.slice(start + "<script>".length, end);
}

test("the built artifact is a single self-contained file", () => {
  assert.match(dist, /<title>Order of Play<\/title>/);
  assert.equal(
    /<script[^>]+src=/.test(dist),
    false,
    "no external scripts: the artifact must run from one document"
  );
  // Fonts are the one permitted external stylesheet.
  const sheets = dist.match(/<link[^>]+stylesheet[^>]*>/g) || [];
  sheets.forEach((tag) => {
    assert.match(tag, /fonts\.googleapis\.com/, "stylesheets come from Google Fonts only");
  });
});

test("no module syntax survives the bundle", () => {
  const script = inlineScript(dist);
  assert.equal(/^\s*import\s/m.test(script), false, "imports were stripped");
  assert.equal(/^\s*export\s/m.test(script), false, "exports were stripped");
  assert.equal(script.includes("/*__CORE__*/"), false, "the marker was replaced");
});

test("the bundled script is syntactically valid JavaScript", async () => {
  const script = inlineScript(dist);
  // Compiled, not executed: there is no DOM here, but a syntax error would throw.
  assert.doesNotThrow(() => new Function(script), "the bundle parses");
});

test("every core module is present in the bundle", async () => {
  const modules = (await readdir(path.join(ROOT, "src", "core"))).filter((f) => f.endsWith(".js"));
  assert.ok(modules.length >= 8, "the core is actually split up");
  modules.forEach((name) => {
    assert.ok(dist.includes(`src/core/${name}`), `${name} is labelled in the bundle`);
  });
});

test("every core function the shell calls actually exists", async () => {
  const shell = await readFile(path.join(ROOT, "src", "shell.html"), "utf8");
  const coreDir = path.join(ROOT, "src", "core");
  const files = (await readdir(coreDir)).filter((f) => f.endsWith(".js"));

  const exported = new Set();
  for (const name of files) {
    const source = await readFile(path.join(coreDir, name), "utf8");
    for (const m of source.matchAll(
      /^export\s+(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm
    )) {
      exported.add(m[1]);
    }
  }
  assert.ok(exported.size > 40, "the core exports a real surface");

  const body = shell.slice(shell.indexOf("/*__CORE__*/"));

  // Everything the shell declares for itself, at any nesting depth. Declaration
  // lists ("var db = null, ask = null;") bind every name in the list, not just
  // the first, so the whole statement is split rather than regexed per name.
  const local = new Set();
  for (const m of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of body.matchAll(/\b(?:var|let|const)\s+([^;{}]+?);/g)) {
    m[1].split(",").forEach((part) => {
      const name = part.trim().split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) local.add(name);
    });
  }
  // Names bound as parameters or object keys rather than declarations.
  for (const m of body.matchAll(/function\s*\(([^)]*)\)/g)) {
    m[1].split(",").forEach((raw) => {
      const name = raw.trim();
      if (name) local.add(name);
    });
  }
  for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) local.add(m[1]);

  const browser = new Set([
    "String", "Number", "Boolean", "Array", "Object", "Math", "JSON", "Date", "Set", "Map",
    "Promise", "Error", "Blob", "FileReader", "URL", "AbortController", "TextEncoder",
    "setTimeout", "clearTimeout", "isNaN", "parseInt", "parseFloat", "encodeURIComponent",
    "if", "for", "while", "switch", "catch", "return", "typeof", "function", "test"
  ]);

  const called = new Set();
  for (const m of body.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);

  const unresolved = [...called].filter(
    (name) => !exported.has(name) && !local.has(name) && !browser.has(name)
  );
  assert.deepEqual(
    unresolved,
    [],
    "these calls resolve to nothing at runtime — a typo or a missing core export"
  );

  const fromCore = [...called].filter((name) => exported.has(name) && !local.has(name));
  assert.ok(fromCore.length > 25, `the shell calls ${fromCore.length} core functions`);
});

test("the shell does not redeclare a core name", async () => {
  const shell = await readFile(path.join(ROOT, "src", "shell.html"), "utf8");
  const coreDir = path.join(ROOT, "src", "core");
  const files = (await readdir(coreDir)).filter((f) => f.endsWith(".js"));
  const exported = new Set();
  for (const name of files) {
    const source = await readFile(path.join(coreDir, name), "utf8");
    for (const m of source.matchAll(
      /^export\s+(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm
    )) {
      exported.add(m[1]);
    }
  }
  const body = shell.slice(shell.indexOf("/*__CORE__*/"));
  const shadowed = [];
  for (const m of body.matchAll(/^\s{2}(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (exported.has(m[1])) shadowed.push(m[1]);
  }
  assert.deepEqual(shadowed, [], "the shell would shadow these core names after bundling");
});

test("build --check passes against the committed dist", async () => {
  const { stdout } = await run(process.execPath, ["build.mjs", "--check"], { cwd: ROOT });
  assert.match(stdout, /dist is current/, "dist/ is in sync with src/");
});

test("the artifact declares the capabilities it needs in its own copy", () => {
  // Documented in the README rather than the file, but the page must degrade
  // when they are absent — which means never assuming window.claude exists.
  assert.match(dist, /window\.claude && typeof window\.claude\.use === "function"/);
  assert.ok(dist.includes('use("db")'), "the store capability is requested");
  assert.ok(dist.includes('use("sample")'), "the sampling capability is requested");
});

test("the top model tier remains unreachable in the built file", () => {
  assert.match(dist, /ALLOWED_TIERS = \["quick","default"\]/);
  const script = inlineScript(dist);
  assert.equal(
    /modelTier\s*:\s*["']complex["']/.test(script),
    false,
    "complex is never sent"
  );
});

test("the artifact stays well under the artifact size limit", () => {
  const kb = Buffer.byteLength(dist, "utf8") / 1024;
  assert.ok(kb < 400, `bundle is ${kb.toFixed(0)} KB`);
});
