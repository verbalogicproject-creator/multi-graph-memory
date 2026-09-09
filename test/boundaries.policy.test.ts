/**
 * The boundary policy, asserted directly.
 *
 * `npm run check:boundaries` scans the real tree and reports on it. That proves
 * today's source is clean; it cannot prove the guard would notice a layer that
 * does not exist yet. It could not: the rule used to be a denylist of nine
 * directory names, so `src/tui/` and `src/serve/` -- the two this phase adds --
 * were permitted purely by having been forgotten. Core could have imported
 * express and a websocket server straight past a guard whose only job is to
 * keep those out, and the check would have printed a tick.
 *
 * These cases are the ones the scan structurally cannot cover, so they are
 * asserted against the pure decision instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { violationsFor, CORE_TYPE_ONLY_SEAM } from "../tooling/check-boundaries.mjs";

const core = (source: string) => violationsFor("src/core/example.ts", source);

test("core may not reach a layer that did not exist when the rule was written", () => {
  for (const layer of ["serve", "tui", "visualization", "kg", "cli", "a-layer-invented-tomorrow"]) {
    const found = core(`import { thing } from "../${layer}/index.ts";\n`);
    assert.equal(found.length, 1, `core importing ../${layer}/ must be one violation`);
    assert.match(found[0]!, new RegExp(`core may not reach the ${layer} layer`));
  }
});

test("the storage seam is allowed, and only as a type-only import", () => {
  const seam = [...CORE_TYPE_ONLY_SEAM][0]!;
  assert.deepEqual(
    core(`import type { StorageAdapter } from "${seam}";\n`),
    [],
    "the type-only seam import is how core is written and must stay legal",
  );
  // A value import of the same path is a real runtime dependency, not the seam.
  const value = core(`import { StorageAdapter } from "${seam}";\n`);
  assert.equal(value.length, 1);
  assert.match(value[0]!, /only with `import type`/);
});

test("a dynamic import can never claim to be type-only", () => {
  const seam = [...CORE_TYPE_ONLY_SEAM][0]!;
  const found = core(`const s = await import("${seam}");\n`);
  assert.equal(found.length, 1, "a runtime import of the seam is a runtime dependency");
});

test("the package rules still hold", () => {
  assert.deepEqual(core(`import { z } from "zod";\n`), []);
  assert.match(core(`import fs from "node:fs";\n`)[0]!, /no filesystem I\/O/);
  assert.match(core(`import ws from "ws";\n`)[0]!, /unapproved package/);
});

test("layers other than core are not policed by this rule", () => {
  assert.deepEqual(
    violationsFor("src/serve/index.ts", `import express from "express";\nimport { x } from "../core/types.ts";\n`),
    [],
    "only core is constrained; a sibling layer may import express and read core",
  );
});
