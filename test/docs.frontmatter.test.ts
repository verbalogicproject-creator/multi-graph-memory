import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphMemoryError } from "../src/core/errors.ts";
import { GraphMemory } from "../src/port.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { documentPath, projectDocuments } from "../src/docs/projector.ts";
import { inspectDocument, parseDocument, serializeDocument } from "../src/docs/frontmatter.ts";
import { ingestAuthoredDocument, parseSections } from "../src/docs/ingest.ts";
import { PROJECT, T2 } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fgm-docs-"));
  const storage = new MemoryStorageAdapter();
  storage.open();
  const memory = new GraphMemory({ storage, scope: { projectId: PROJECT } });
  return { dir, memory, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("generated documents round-trip through their frontmatter", () => {
  const text = serializeDocument(
    { projectId: "p", schemaVersion: 1, generatedAt: T2, sourceEventCount: 3, generator: "test" },
    "# Body\n\nsome content",
  );
  const parsed = parseDocument(text);
  assert.equal(parsed.frontmatter?.projectId, "p");
  assert.equal(parsed.frontmatter?.sourceEventCount, 3);
  assert.equal(parsed.body.trim(), "# Body\n\nsome content");
  assert.equal(inspectDocument(text, "p").status, "pristine");
});

test("a hand edit is detected and the file is REFUSED, not overwritten", () => {
  const { dir, memory, cleanup } = setup();
  try {
    projectDocuments(memory, dir, T2);
    const path = documentPath(dir, PROJECT, "LESSONS");

    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}\n\nA human added this line by hand.\n`, "utf8");
    assert.equal(inspectDocument(readFileSync(path, "utf8"), PROJECT).status, "hand-edited");

    const result = projectDocuments(memory, dir, T2);
    assert.equal(result.refused.length, 1);
    assert.match(result.refused[0]!.reason, /Refusing to overwrite/);

    // The human's text is still there.
    assert.match(readFileSync(path, "utf8"), /A human added this line by hand/);
    // And the other documents still regenerated.
    assert.equal(result.written.length, 2);
  } finally {
    cleanup();
  }
});

test("a file belonging to another project is refused as foreign", () => {
  const foreign = serializeDocument(
    { projectId: "someone-else", schemaVersion: 1, generatedAt: T2, sourceEventCount: 0, generator: "test" },
    "# Body",
  );
  assert.equal(inspectDocument(foreign, PROJECT).status, "foreign");
});

test("a file with no frontmatter at all is refused rather than clobbered", () => {
  const { dir, memory, cleanup } = setup();
  try {
    const path = documentPath(dir, PROJECT, "MEMORY");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "# My own notes\n\nI wrote this myself.\n", "utf8");

    const result = projectDocuments(memory, dir, T2);
    assert.ok(result.refused.some((r) => r.path === path));
    assert.match(readFileSync(path, "utf8"), /I wrote this myself/);
  } finally {
    cleanup();
  }
});

test("regenerating a pristine file is allowed", () => {
  const { dir, memory, cleanup } = setup();
  try {
    const first = projectDocuments(memory, dir, T2);
    assert.equal(first.written.length, 3);
    const second = projectDocuments(memory, dir, T2);
    assert.equal(second.written.length, 3);
    assert.equal(second.refused.length, 0);
  } finally {
    cleanup();
  }
});

test("every heading becomes its own section regardless of length", () => {
  const sections = parseSections(
    ["# Top", "intro", "## A", "one line", "## B", "another line", "### B1", "nested line"].join("\n"),
  );
  const titles = sections.map((s) => s.title);
  assert.deepEqual(titles, ["Top", "A", "B", "B1"]);
  assert.deepEqual(sections.find((s) => s.title === "B1")?.breadcrumb, ["Top", "B", "B1"]);
  assert.equal(sections.find((s) => s.title === "A")?.body.trim(), "one line");
});

test("authored documents ingest as evidence; generated ones are skipped", () => {
  const { dir, memory, cleanup } = setup();
  try {
    const authored = join(dir, `${PROJECT}-ARCHITECTURE.md`);
    writeFileSync(authored, "# Boundaries\n\nNo deep imports.\n\n## Dependencies\n\nExact-name admission only.\n", "utf8");

    const result = ingestAuthoredDocument(memory, authored);
    assert.equal(result.evidence.length, 2);
    assert.equal(result.skipped.length, 0);

    projectDocuments(memory, dir, T2);
    const generated = ingestAuthoredDocument(memory, documentPath(dir, PROJECT, "LESSONS"));
    assert.equal(generated.evidence.length, 0);
    assert.match(generated.skipped[0]!, /generated projection/);
  } finally {
    cleanup();
  }
});

test("an authored section containing a credential is skipped, not indexed", () => {
  const { dir, memory, cleanup } = setup();
  try {
    const authored = join(dir, `${PROJECT}-NOTES.md`);
    writeFileSync(
      authored,
      "# Safe\n\nordinary prose\n\n# Unsafe\n\nkey = AIzaSyA1234567890abcdefghijklmnopqrstuvw\n",
      "utf8",
    );
    const result = ingestAuthoredDocument(memory, authored);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!, /Unsafe/);
  } finally {
    cleanup();
  }
});
