#!/usr/bin/env node
/**
 * Boundary policy, modelled on the check:boundaries convention this component
 * was originally written against. See PROVENANCE.md.
 *
 * Rulings 1 and 2 claim the governance core is pure: no provider code, no
 * network, no optional features, no credentials. A claim in a README is not a
 * guarantee. This turns it into a check that fails the build.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** src/core/** may import only from within core, and only these packages. */
export const CORE_ALLOWED_PACKAGES = new Set(["zod", "zod/v4", "node:crypto"]);

export const FORBIDDEN_IN_CORE = [
  { pattern: /^node:http/, why: "the core performs no network I/O" },
  { pattern: /^node:https/, why: "the core performs no network I/O" },
  { pattern: /^node:net/, why: "the core performs no network I/O" },
  { pattern: /^node:fs/, why: "the core performs no filesystem I/O" },
  { pattern: /^node:sqlite/, why: "storage belongs to an adapter, not the core" },
  { pattern: /@google\/genai/, why: "the core carries no provider dependency" },
];

/**
 * The one escape core is allowed, named rather than implied.
 *
 * This used to be a denylist of nine sibling directories, and a denylist is a
 * blind spot by construction: a layer added later was permitted by having been
 * forgotten. `src/tui/` and `src/serve/` would each have been reachable from
 * core -- express and a websocket server, past a guard whose whole job is to
 * keep those out -- and the check would have stayed green. The rule is now the
 * one line 16 always claimed: core may not reach a sibling layer at all.
 *
 * Core genuinely does depend on the storage *seam* -- six type-only imports of
 * the interface it is written against. That is the abstraction core is built
 * on, not a layer crossing, so it is allowed explicitly and only in its
 * type-only form. A value import of the same path is a real dependency at
 * runtime and stays a violation.
 */
export const CORE_TYPE_ONLY_SEAM = new Set(["../adapters/storage.ts"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments before scanning for imports.
 *
 * Without this the scanner reads prose. A doc comment in `src/core/component.ts`
 * containing the words `from "malformed"` was reported as core importing an
 * unapproved package, which is a guard firing on documentation -- and a guard
 * that cries wolf is one people learn to skip past. Strings are left alone:
 * removing them would risk hiding a real specifier.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * Returns `{ spec, typeOnly }` per import. `typeOnly` is true only for the
 * `import type ... from` / `export type ... from` statement form -- not for
 * `import { type X }`, which is deliberately not treated as a declaration of
 * intent strong enough to cross a boundary on.
 */
export function importsOf(rawSource) {
  const source = stripComments(rawSource);
  const specifiers = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[\s\S]*?from\s+["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    specifiers.push({ spec: match[2], typeOnly: Boolean(match[1]) });
  }
  const dynamic = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) {
    // A dynamic import is always a runtime dependency; it can never be type-only.
    specifiers.push({ spec: match[1], typeOnly: false });
  }
  return specifiers;
}

/**
 * The whole policy, as a pure function of one file's path and text.
 *
 * Pure on purpose: this is the decision, and a decision that can be made pure
 * is one `npm test` can assert directly instead of a script asserting it about
 * itself. See `test/boundaries.policy.test.ts`.
 */
export function violationsFor(rel, source) {
  const found = [];
  const isCore = rel.startsWith("src/core/");

  for (const { spec, typeOnly } of importsOf(source)) {
    const isRelative = spec.startsWith(".");

    if (isCore) {
      if (isRelative) {
        if (spec.includes("../")) {
          // Denied by default. Being a directory nobody thought to list is not
          // a reason to be allowed.
          if (!(typeOnly && CORE_TYPE_ONLY_SEAM.has(spec))) {
            const layer = spec.replace(/^(\.\.\/)+/, "").split("/")[0];
            const detail = CORE_TYPE_ONLY_SEAM.has(spec)
              ? "the storage seam may be imported only with `import type`"
              : `core may not reach the ${layer} layer`;
            found.push(`${rel}: core imports "${spec}" — ${detail}`);
          }
        }
      } else {
        for (const { pattern, why } of FORBIDDEN_IN_CORE) {
          if (pattern.test(spec)) found.push(`${rel}: core imports "${spec}" — ${why}`);
        }
        if (!CORE_ALLOWED_PACKAGES.has(spec)) {
          found.push(`${rel}: core imports unapproved package "${spec}"`);
        }
      }
    }

    // The relevance layer declares the embedding seam but must not bind a provider.
    if (rel.startsWith("src/relevance/") && /@google\/genai/.test(spec)) {
      found.push(`${rel}: the relevance layer must not depend on a provider SDK`);
    }
  }
  return found;
}

/** Only scan the tree when run as a command, so importing this stays cheap. */
const runningAsScript = process.argv[1] && process.argv[1].endsWith("check-boundaries.mjs");
if (!runningAsScript) {
  // Imported for its pure exports; the caller does the asserting.
} else {

const violations = [];

for (const file of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, file);
  violations.push(...violationsFor(rel, readFileSync(file, "utf8")));
}

if (violations.length > 0) {
  console.error("Boundary policy violations:\n");
  for (const v of violations) console.error(`  ✖ ${v}`);
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log(
  "✔ boundary policy: core is pure — no provider, network, filesystem or storage imports, " +
    "and no sibling layer reachable except the type-only storage seam",
);
}

