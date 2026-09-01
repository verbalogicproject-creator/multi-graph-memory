/**
 * Typed refusals for Graph Memory.
 *
 * Ruling 1: authority refusal is implemented as explicit errors, not documentation.
 * Every guard in the governance core throws one of these rather than degrading
 * silently, so a caller can never mistake a refusal for an empty result.
 */

export const ERROR_CODES = [
  // validation and payload boundary
  "VALIDATION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "IMMUTABLE_EVENT",
  // redaction / transmission boundary (Ruling 3)
  "SECRET_DETECTED",
  // scope and isolation (Ruling 5)
  "SCOPE_REQUIRED",
  "PROJECT_MISMATCH",
  "FEDERATION_NOT_ADMITTED",
  "REHOME_NOT_APPROVED",
  // lesson lifecycle (Rulings 1, 7, 8)
  "LESSON_TRANSITION_INVALID",
  "REUSE_SAME_EPISODE",
  "HUMAN_APPROVAL_REQUIRED",
  "CONTRADICTION_BLOCKS_PROMOTION",
  "DEVIATION_NOT_QUALIFIED",
  // portability (Ruling 4)
  "CHECKSUM_MISMATCH",
  "SCHEMA_VERSION_UNSUPPORTED",
  "MIGRATION_ROUTE_INVALID",
  // relevance (Ruling 2)
  "EMBEDDING_SPACE_MISMATCH",
  // documents (Ruling 11)
  "DOCUMENT_HAND_EDITED",
  // control tier (Ruling 6)
  "CONTROL_TIER_CONTENT_REFUSED",
  // the catch-all authority boundary
  "AUTHORITY_REFUSED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class GraphMemoryError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "GraphMemoryError";
    this.code = code;
    this.detail = detail;
  }
}

/** Convenience constructor so call sites read as refusals, not as generic throws. */
export function refuse(
  code: ErrorCode,
  message: string,
  detail: Record<string, unknown> = {},
): never {
  throw new GraphMemoryError(code, message, detail);
}

/**
 * One validation issue, structurally shaped so this file needs no schema library.
 * `path` is `PropertyKey[]` because that is what the validator produces — a
 * segment can be a symbol, and stringifying is this file's job rather than every
 * call site's.
 */
export interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Beyond this, a message stops informing and starts scrolling. */
const ISSUES_IN_MESSAGE = 3;

/**
 * A schema refusal that names what was wrong, in the sentence.
 *
 * The issues were always in `detail`. But logging `error.message` and dropping
 * the rest is the normal thing to do at a process boundary, and a consumer that
 * did lost a whole class of events to one undeclared `domain` value — reported
 * to it as a count, with the field never named. Which field, and which value,
 * belongs where anyone will actually read it.
 *
 * `detail.issues` keeps every issue; the message shows the first few.
 */
export function refuseSchema(subject: string, issues: readonly SchemaIssue[]): never {
  const named = issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
  const shown = named
    .slice(0, ISSUES_IN_MESSAGE)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
  const hidden = named.length - shown.length;
  const summary = shown.join("; ") + (hidden > 0 ? ` (+${hidden} more)` : "");
  refuse(
    "VALIDATION_FAILED",
    summary ? `${subject} failed schema validation — ${summary}` : `${subject} failed schema validation.`,
    { issues: named },
  );
}

export function isGraphMemoryError(value: unknown): value is GraphMemoryError {
  return value instanceof GraphMemoryError;
}

/**
 * Memory grants no filesystem, dependency, donor, model, network, revision or
 * deployment authority. Any surface tempted to offer one calls this instead.
 */
export function refuseAuthority(surface: string): never {
  return refuse(
    "AUTHORITY_REFUSED",
    `Graph Memory grants no ${surface} authority. Project revisions and the System Design Contract remain stronger truth.`,
    { surface },
  );
}
