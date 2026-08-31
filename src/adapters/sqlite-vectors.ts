/**
 * SQLite-backed vector store.
 *
 * Vectors are stored as raw Float32 bytes -- the same byte layout the browser
 * projection would use for an ArrayBuffer, so a vector is portable between
 * adapters without re-encoding.
 */

import { DatabaseSync } from "node:sqlite";
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

export class SqliteVectorStore implements VectorStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
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
  }

  list(projectId: string): StoredLessonVector[] {
    return (this.db.prepare("SELECT * FROM lesson_vectors WHERE project_id = ?").all(projectId) as Row[]).map(decode);
  }

  remove(lessonId: string): void {
    this.db.prepare("DELETE FROM lesson_vectors WHERE lesson_id = ?").run(lessonId);
  }

  close(): void {
    this.db.close();
  }
}
