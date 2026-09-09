#!/usr/bin/env node
/**
 * Ruling 2, proven rather than asserted.
 *
 * "The core and its full test suite must work with no network, API key, Gemini
 * dependency, or provider call."
 *
 * A README claim is not evidence. This temporarily removes @google/genai from
 * node_modules, clears GEMINI_API_KEY, runs the boundary policy, the TYPE CHECK
 * and the entire suite, and restores afterwards. If anything in the package
 * quietly depends on the provider, this fails.
 *
 * The typecheck is here because leaving it out was a false green of exactly the
 * kind this file exists to prevent. `node --test` strips types and never asks
 * the resolver to find a module, so the suite passed with the provider absent
 * while `npm run build` -- and therefore `prepare`, and therefore every
 * directory install, including multi-app's `file:../multi-graph-memory` --
 * failed with TS2307 on a literal `import("@google/genai")`. The check ran, went
 * green, and was never looking at the half that broke.
 */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PROVIDER = join(ROOT, "node_modules", "@google", "genai");
const STASH = join(ROOT, "node_modules", "@google", ".genai-stashed-by-verify-pure");

function run(command, args) {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", env });
}

let stashed = false;
try {
  if (existsSync(PROVIDER)) {
    rmSync(STASH, { recursive: true, force: true });
    renameSync(PROVIDER, STASH);
    stashed = true;
    console.log("• @google/genai removed from node_modules");
  } else {
    console.log("• @google/genai is not installed");
  }
  console.log("• GEMINI_API_KEY cleared from the environment\n");

  run("node", ["tooling/check-boundaries.mjs"]);
  // Before the suite: a resolver error here is the cheaper, clearer failure.
  run("npx", ["tsc", "--noEmit"]);
  run("node", ["--test", "test/**/*.test.ts"]);

  console.log("\n✔ verify:pure — the package typechecks and passes with no provider package, no key and no network.");
} catch (error) {
  console.error("\n✖ verify:pure FAILED: something depends on the provider, a key, or the network.");
  process.exitCode = 1;
} finally {
  if (stashed && existsSync(STASH)) {
    rmSync(PROVIDER, { recursive: true, force: true });
    renameSync(STASH, PROVIDER);
    console.log("• @google/genai restored");
  }
}
