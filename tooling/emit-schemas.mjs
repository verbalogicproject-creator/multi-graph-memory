#!/usr/bin/env node
/**
 * Emits JSON Schema artifacts from the zod definitions into schemas/.
 *
 * Decision 2 of the plan: Codex gets machine-readable schemas it can validate a
 * bundle against independently, rather than having to trust this implementation.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(ROOT, "schemas");

const { EXPORTED_SCHEMAS, toJsonSchema } = await import(join(ROOT, "src/core/schema.ts"));

mkdirSync(OUT, { recursive: true });

const written = [];
for (const name of Object.keys(EXPORTED_SCHEMAS)) {
  const schema = toJsonSchema(name);
  const doc = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `${name}.schema.json`, ...schema };
  const file = join(OUT, `${name}.schema.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  written.push(`${name}.schema.json`);
}

console.log(`✔ emitted ${written.length} JSON Schema artifact(s) into schemas/`);
for (const name of written) console.log(`  - ${name}`);
