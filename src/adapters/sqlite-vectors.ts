/**
 * SQLite-backed vector store.
 *
 * Vectors are stored as raw Float32 bytes -- the same byte layout the browser
 * projection would use for an ArrayBuffer, so a vector is portable between
 * adapters without re-encoding. That layout is also exactly what `sqlite-vec`'s
 * `vec0` wants, which is why the KNN index below is a shadow of the same bytes
 * rather than a second copy in a second format.
 *
 * **The KNN index is optional and additive.** `sqlite-vec` is an optionalDependency;
 * when its extension is absent, `knn()` returns null, every other method behaves
 * exactly as it did before, and the deterministic path is untouched. `verify:pure`
 * must keep passing with the package deleted -- an offline, keyless cluster is the
 * contract, and a vector index is a convenience layered on top of it, never a
 * requirement underneath it.
 */

import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { bufferToFloat32, float32ToBuffer } from "../relevance/vendored/math.ts";
import type { StoredLessonVector, VectorStore } from "../relevance/vector-store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lesson_vectors (
  lesson_id             TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  model_id              TEXT NOT NULL,
  dimensions            INTEGER NOT NULL,
  prompt_format_version TEXT NOT NULL,
  content_digest        TEXT NOT NULL,
  embedded_at           TEXT NOT NULL,
  embedding             BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vectors_project ON lesson_vectors(project_id);
`;

type Row = Record<string, unknown>;

function decode(row: Row): StoredLessonVector {
  return {
    lessonId: String(row.lesson_id),
    projectId: String(row.project_id),
    values: bufferToFloat32(row.embedding as Buffer),
    metadata: {
      modelId: String(row.model_id),
      dimensions: Number(row.dimensions),
      promptFormatVersion: String(row.prompt_format_version),
    },
    contentDigest: String(row.content_digest),
    embeddedAt: String(row.embedded_at),
  };
}

/**
 * Resolve the `sqlite-vec` loadable extension, or null when it is not installed.
 *
 * Deliberately tolerant: a missing optional dependency, a platform with no
 * prebuilt binary, or a refusal to load are all the same answer -- no index.
 */
function resolveVecExtension(): string | null {
  const declared = process.env.SQLITE_VEC_PATH;
  if (declared) return declared;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (createRequire(import.meta.url)("sqlite-vec") as { getLoadablePath(): string }).getLoadablePath();
  } catch {
    return null;
  }
}

export class SqliteVectorStore implements VectorStore {
  private readonly db: DatabaseSync;
  /** Dimension the vec0 shadow table was created for, or null while unused. */
  private vecDimensions: number | null = null;
  private readonly vecEnabled: boolean;

  constructor(path: string) {
    if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
    const extension = resolveVecExtension();
    // `new DatabaseSync(path, undefined)` is NOT the same as omitting the argument:
    // node:sqlite rejects an explicit undefined with ERR_INVALID_ARG_TYPE. Without this
    // branch the store throws on every machine that does not have sqlite-vec installed,
    // which is exactly the configuration the optional dependency is supposed to support.
    this.db = extension ? new DatabaseSync(path, { allowExtension: true }) : new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // Same reason as the main store: this file has more than one legitimate
    // writer, and without a timeout the second fails instantly on any overlap.
    this.db.exec("PRAGMA busy_timeout = 2000;");
    this.db.exec(SCHEMA);

    let enabled = false;
    if (extension) {
      try {
        this.db.enableLoadExtension(true);
        this.db.loadExtension(extension);
        this.db.enableLoadExtension(false);
        enabled = true;
        const existing = this.db
          .prepare("SELECT dimensions FROM lesson_vectors LIMIT 1")
          .get() as { dimensions?: number } | undefined;
        if (existing?.dimensions) this.ensureVecTable(Number(existing.dimensions));
      } catch {
        enabled = false;
      }
    }
    this.vecEnabled = enabled;
  }

  /** True when KNN is available. Callers must branch on this, never assume. */
  get knnAvailable(): boolean {
    return this.vecEnabled;
  }

  /**
   * vec0 fixes its dimension at creation, so the shadow table is built for the
   * first dimension seen. Vectors of any other dimension are not indexed -- and
   * they are already excluded from scoring by the embedding-space partition, so
   * skipping them here loses nothing that would have been used.
   */
  private ensureVecTable(dimensions: number): void {
    if (!this.vecEnabled && this.vecDimensions === null && dimensions <= 0) return;
    if (this.vecDimensions !== null) return;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS lesson_vec USING vec0(
           lesson_rowid INTEGER PRIMARY KEY,
           embedding float[${dimensions}] distance_metric=cosine
         );`,
      );
      this.vecDimensions = dimensions;
    } catch {
      this.vecDimensions = null;
    }
  }

  get(lessonId: string): StoredLessonVector | null {
    const row = this.db.prepare("SELECT * FROM lesson_vectors WHERE lesson_id = ?").get(lessonId) as Row | undefined;
    return row ? decode(row) : null;
  }

  put(vector: StoredLessonVector): void {
    this.db
      .prepare(
        `INSERT INTO lesson_vectors (lesson_id, project_id, model_id, dimensions,
           prompt_format_version, content_digest, embedded_at, embedding)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(lesson_id) DO UPDATE SET model_id=excluded.model_id,
           dimensions=excluded.dimensions, prompt_format_version=excluded.prompt_format_version,
           content_digest=excluded.content_digest, embedded_at=excluded.embedded_at,
           embedding=excluded.embedding`,
      )
      .run(
        vector.lessonId, vector.projectId, vector.metadata.modelId, vector.metadata.dimensions,
        vector.metadata.promptFormatVersion, vector.contentDigest, vector.embeddedAt,
        float32ToBuffer(vector.values),
      );
    this.indexVector(vector);
  }

  /** Mirror one vector into the vec0 shadow. Never throws into the write path. */
  private indexVector(vector: StoredLessonVector): void {
    if (!this.vecEnabled) return;
    this.ensureVecTable(vector.metadata.dimensions);
    if (this.vecDimensions !== vector.metadata.dimensions) return;
    try {
      const row = this.db
        .prepare("SELECT rowid FROM lesson_vectors WHERE lesson_id = ?")
        .get(vector.lessonId) as { rowid?: number | bigint } | undefined;
      if (row?.rowid === undefined) return;
      const rowid = BigInt(row.rowid);
      this.db.prepare("DELETE FROM lesson_vec WHERE lesson_rowid = ?").run(rowid);
      this.db
        .prepare("INSERT INTO lesson_vec(lesson_rowid, embedding) VALUES (?, ?)")
        .run(rowid, float32ToBuffer(vector.values));
    } catch {
      /* An unusable index must never fail a write. The scan path still answers. */
    }
  }

  /**
   * Nearest lessons in embedding space, or null when no index is available.
   *
   * Returns cosine SIMILARITY (1 - distance) so the caller compares it against
   * the same numbers the JS scan produces. Over-fetches before filtering by
   * project because vec0 applies its k before any join, so filtering first would
   * silently return fewer than k.
   */
  knn(projectId: string, query: Float32Array, k: number): { lessonId: string; score: number }[] | null {
    if (!this.vecEnabled || this.vecDimensions !== query.length) return null;
    try {
      const rows = this.db
        .prepare(
          `SELECT lv.lesson_id AS lesson_id, v.distance AS distance
             FROM lesson_vec v
             JOIN lesson_vectors lv ON lv.rowid = v.lesson_rowid
            WHERE v.embedding MATCH ? AND k = ?
            ORDER BY v.distance`,
        )
        .all(float32ToBuffer(query), Math.max(k * 4, k)) as { lesson_id: string; distance: number }[];
      return rows
        .filter((r) => {
          const owner = this.db
            .prepare("SELECT project_id FROM lesson_vectors WHERE lesson_id = ?")
            .get(r.lesson_id) as { project_id?: string } | undefined;
          return owner?.project_id === projectId;
        })
        .slice(0, k)
        .map((r) => ({ lessonId: r.lesson_id, score: 1 - Number(r.distance) }));
    } catch {
      return null;
    }
  }

  list(projectId: string): StoredLessonVector[] {
    return (this.db.prepare("SELECT * FROM lesson_vectors WHERE project_id = ?").all(projectId) as Row[]).map(decode);
  }

  remove(lessonId: string): void {
    if (this.vecEnabled && this.vecDimensions !== null) {
      try {
        const row = this.db
          .prepare("SELECT rowid FROM lesson_vectors WHERE lesson_id = ?")
          .get(lessonId) as { rowid?: number | bigint } | undefined;
        if (row?.rowid !== undefined) {
          this.db.prepare("DELETE FROM lesson_vec WHERE lesson_rowid = ?").run(BigInt(row.rowid));
        }
      } catch {
        /* index drift is recoverable by rebuild; a failed delete must not block one */
      }
    }
    this.db.prepare("DELETE FROM lesson_vectors WHERE lesson_id = ?").run(lessonId);
  }

  close(): void {
    this.db.close();
  }
}
