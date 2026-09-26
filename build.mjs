#!/usr/bin/env node
/**
 * Build one publishable artifact out of the core modules and the shell.
 *
 * The deployment target has not changed: a Claude Artifact is a single HTML
 * document, and `dist/order-of-play.html` is that document, committed so that
 * publishing never requires running this script. What changed is that the domain
 * logic is no longer trapped inside it.
 *
 * The transform is deliberately dull. Core modules are real ES modules that Node
 * imports directly in the test suite, so the tests exercise exactly the source
 * this script inlines — there is no second copy of the logic to drift. Building
 * means: sort the modules by their import graph, strip the module syntax, and
 * concatenate them into one shared scope inside the shell's IIFE.
 *
 * Because that shared scope is flat, two modules cannot both declare the same
 * top-level name. Rather than hope, the build checks and fails loudly.
 *
 * Usage:  node build.mjs [--check]
 *   --check  verify dist/ is current without writing it (used by CI)
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.join(ROOT, "src", "core");
const SHELL = path.join(ROOT, "src", "shell.html");
const OUT = path.join(ROOT, "dist", "order-of-play.html");
const MARKER = "/*__CORE__*/";

const IMPORT_RE = /^\s*import\s+[\s\S]*?from\s+["']([^"']+)["'];?\s*$/gm;
const EXPORT_LIST_RE = /^\s*export\s*\{[^}]*\};?\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(const|let|var|function|class|async function)\s/gm;
const DECL_RE = /^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm;

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

async function readModules() {
  const names = (await readdir(CORE_DIR)).filter((f) => f.endsWith(".js")).sort();
  const modules = new Map();
  for (const name of names) {
    const source = await readFile(path.join(CORE_DIR, name), "utf8");
    if (/^\s*export\s+default/m.test(source)) {
      fail(`${name} uses "export default"; core modules must use named exports only`);
    }
    const deps = [];
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith("./")) {
        fail(`${name} imports "${spec}"; core modules may only import siblings`);
      }
      deps.push(path.basename(spec));
    }
    modules.set(name, { name, source, deps });
  }
  return modules;
}

/** Depth-first topological sort, with a cycle check. */
function sortModules(modules) {
  const order = [];
  const done = new Set();
  const active = new Set();

  function visit(name, trail) {
    if (done.has(name)) return;
    if (active.has(name)) {
      fail(`import cycle: ${trail.concat(name).join(" -> ")}`);
    }
    const mod = modules.get(name);
    if (!mod) fail(`${trail[trail.length - 1] || "?"} imports missing module ${name}`);
    active.add(name);
    mod.deps.forEach((dep) => visit(dep, trail.concat(name)));
    active.delete(name);
    done.add(name);
    order.push(mod);
  }

  [...modules.keys()].forEach((name) => visit(name, []));
  return order;
}

/** Remove module syntax, leaving plain declarations in one shared scope. */
function stripModuleSyntax(source) {
  return source
    .replace(IMPORT_RE, "")
    .replace(EXPORT_LIST_RE, "")
    .replace(EXPORT_DECL_RE, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectTopLevelNames(code, name, seen) {
  for (const match of code.matchAll(DECL_RE)) {
    const declared = match[1];
    if (seen.has(declared)) {
      fail(
        `${name} redeclares "${declared}", already declared in ${seen.get(declared)}. ` +
          "Core modules share one scope after bundling, so top-level names must be unique."
      );
    }
    seen.set(declared, name);
  }
}

async function build() {
  const modules = await readModules();
  const order = sortModules(modules);
  const seen = new Map();

  const chunks = order.map((mod) => {
    const code = stripModuleSyntax(mod.source);
    collectTopLevelNames(code, mod.name, seen);
    return `// ${"─".repeat(68)}\n// src/core/${mod.name}\n// ${"─".repeat(68)}\n\n${code}`;
  });

  const shell = await readFile(SHELL, "utf8");
  if (!shell.includes(MARKER)) fail(`src/shell.html has no ${MARKER} marker`);

  const banner = [
    "// Bundled by build.mjs from src/core/*.js — do not edit this section.",
    "// Edit the modules in src/core/ and run: node build.mjs",
    `// Modules, in dependency order: ${order.map((m) => m.name).join(", ")}`
  ].join("\n");

  const bundle = `${banner}\n\n${chunks.join("\n\n")}`;
  const html = shell.replace(MARKER, () => bundle);

  return { html, order, names: seen.size };
}

const { html, order, names } = await build();
const wantCheck = process.argv.includes("--check");

if (wantCheck) {
  let current = "";
  try {
    current = await readFile(OUT, "utf8");
  } catch (err) {
    fail(`dist/order-of-play.html is missing. Run: node build.mjs`);
  }
  if (current !== html) {
    fail("dist/order-of-play.html is stale. Run: node build.mjs and commit the result.");
  }
  console.log(`build --check: dist is current (${order.length} modules, ${names} names).`);
} else {
  await writeFile(OUT, html, "utf8");
  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(
    `build: wrote dist/order-of-play.html (${kb} KB) from ${order.length} modules ` +
      `[${order.map((m) => m.name.replace(/\.js$/, "")).join(" → ")}]`
  );
}
