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
const CORE_ALLOWED_PACKAGES = new Set(["zod", "zod/v4", "node:crypto"]);

const FORBIDDEN_IN_CORE = [
  { pattern: /^node:http/, why: "the core performs no network I/O" },
  { pattern: /^node:https/, why: "the core performs no network I/O" },
  { pattern: /^node:net/, why: "the core performs no network I/O" },
  { pattern: /^node:fs/, why: "the core performs no filesystem I/O" },
  { pattern: /^node:sqlite/, why: "storage belongs to an adapter, not the core" },
  { pattern: /@google\/genai/, why: "the core carries no provider dependency" },
];

/** Layers that must never be reachable from the core. */
const FORBIDDEN_CORE_DIRS = ["providers", "optional", "relevance", "control", "mcp", "cli", "docs", "visualization", "kg"];

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

function importsOf(rawSource) {
  const source = stripComments(rawSource);
  const specifiers = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  const dynamic = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

const violations = [];

for (const file of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, file);
  const isCore = rel.startsWith("src/core/");
  const source = readFileSync(file, "utf8");

  for (const spec of importsOf(source)) {
    const isRelative = spec.startsWith(".");

    if (isCore) {
      if (isRelative) {
        if (spec.includes("../")) {
          const target = spec.replace(/^(\.\.\/)+/, "");
          const top = target.split("/")[0];
          if (FORBIDDEN_CORE_DIRS.includes(top)) {
            violations.push(`${rel}: core imports "${spec}" from the ${top} layer`);
          }
        }
      } else {
        for (const { pattern, why } of FORBIDDEN_IN_CORE) {
          if (pattern.test(spec)) violations.push(`${rel}: core imports "${spec}" — ${why}`);
        }
        if (!CORE_ALLOWED_PACKAGES.has(spec)) {
          violations.push(`${rel}: core imports unapproved package "${spec}"`);
        }
      }
    }

    // The relevance layer declares the embedding seam but must not bind a provider.
    if (rel.startsWith("src/relevance/") && /@google\/genai/.test(spec)) {
      violations.push(`${rel}: the relevance layer must not depend on a provider SDK`);
    }
  }
}

if (violations.length > 0) {
  console.error("Boundary policy violations:\n");
  for (const v of violations) console.error(`  ✖ ${v}`);
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log("✔ boundary policy: core is pure (no provider, network, filesystem or storage imports)");
