/**
 * Two refusals that used to be indistinguishable from an empty result.
 *
 * Both were found by the first host that depended on this package rather than
 * read it, and both cost the same thing: a caller was told nothing happened,
 * when in fact something had been rejected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEvent } from "../src/core/events.ts";
import { recordEvidence } from "../src/core/evidence.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { GraphMemoryError, refuseSchema } from "../src/core/errors.ts";
import { main, openMemory } from "../src/cli/multi-memory.ts";
import { event } from "./helpers/factory.ts";

/** The thrown refusal itself, since the assertions here are about its wording. */
function caught(fn: () => unknown): GraphMemoryError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GraphMemoryError, `expected a refusal, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal, nothing was thrown");
}

test("a schema refusal names the field and the value it rejected", () => {
  const error = caught(() => prepareEvent({ ...event(), domain: "design" as never }));

  assert.equal(error.code, "VALIDATION_FAILED");
  // In the sentence, not only in `detail`: logging `error.message` and dropping
  // the rest is the normal thing to do at a process boundary, and the host that
  // did lost every event carrying an undeclared domain to a bare count.
  assert.match(error.message, /domain/);
  // And the vocabulary, so the caller learns what WOULD have been accepted.
  assert.match(error.message, /art-direction/);
  assert.deepEqual((error.detail.issues as { path: string }[]).map((i) => i.path), ["domain"]);
});

test("a refusal over many issues stays a sentence, and keeps them all in detail", () => {
  const error = caught(() =>
    refuseSchema("Thing", [
      { path: ["a"], message: "one" },
      { path: ["b"], message: "two" },
      { path: ["c"], message: "three" },
      { path: ["d"], message: "four" },
      { path: ["e"], message: "five" },
    ]),
  );

  assert.match(error.message, /a: one; b: two; c: three \(\+2 more\)/);
  assert.equal((error.detail.issues as unknown[]).length, 5);
});

test("a refusal with no issues at all still reads as a sentence", () => {
  assert.equal(caught(() => refuseSchema("Thing", [])).message, "Thing failed schema validation.");
});

test("each schema refusal names its own subject, not a generic one", () => {
  const storage = new MemoryStorageAdapter();
  storage.open();
  try {
    const error = caught(() => recordEvidence(storage, { kind: "note" } as never));
    assert.match(error.message, /^Evidence failed schema validation/);
    assert.match(error.message, /ref/, "and the field it was missing");
  } finally {
    storage.close();
  }
});

test("an unknown --build is refused by name, and creates nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fgm-build-"));
  const previous = process.env.MULTI_MEMORY_BUILDS;
  process.env.MULTI_MEMORY_BUILDS = dir;

  const errors: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (line: unknown) => { errors.push(String(line)); };
  console.log = () => {};

  try {
    // A cluster that does exist, so the refusal can point at something real.
    const real = openMemory({
      projectRoot: dir, projectId: "real", clusterDir: dir, databasePath: join(dir, "real.db"),
    });
    real.memory.openEpisode({ objective: "a real attempt", baseRevisionId: "rev-1" });
    real.storage.close();

    const code = await main(["--build", "typo-here", "episode", "list"]);

    assert.equal(code, 1, "an unanswerable build id is a failure, not an empty list");
    assert.match(errors.join("\n"), /No database for build "typo-here"/);
    assert.match(errors.join("\n"), /real/, "it says what IS there");
    assert.equal(
      existsSync(join(dir, "typo-here.db")),
      false,
      "opening a database is what creates it, so the check has to come first",
    );
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".db")), ["real.db"]);

    // The positive control: the guard must not have broken the working case.
    assert.equal(await main(["--build", "real", "episode", "list"]), 0);

    // Nor the one workflow that legitimately populates a cluster that does not
    // exist yet. It must get past the guard and fail on its own terms (no bundle
    // at that path) rather than on "no such build".
    errors.length = 0;
    await main(["--build", "restored", "sync", "import", join(dir, "no-such-bundle.json")]);
    assert.doesNotMatch(errors.join("\n"), /No database for build/,
        "sync import is how a bundle is restored into a new cluster");
  } finally {
    console.error = realError;
    console.log = realLog;
    if (previous === undefined) delete process.env.MULTI_MEMORY_BUILDS;
    else process.env.MULTI_MEMORY_BUILDS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
