/**
 * The `component` key: what joins a lesson to the code it is about.
 *
 * `Lesson.component` and `MemoryEvent.component` have existed since the first
 * schema and, as of 2026-09-09, no caller had ever written one: every lesson and
 * every event in multi-app's store carried NULL. Nothing was ambiguous; there
 * was simply nothing to join. So the key gets a declared format, and the format
 * carries its namespace:
 *
 *     repo:<repo>/<repo-relative POSIX path>   a file in a first-party repository
 *     build:<buildId>/<path>                   a file in a generated application
 *     (absent)                                 a fact about a model or a toolchain
 *
 * The namespace is load-bearing. multi-app's builder generates applications
 * whose paths look exactly like multi-app's own -- both have `src/App.tsx` --
 * and builder lessons are shared across every build. Unnamespaced, a lesson
 * about generated code would join the host repository's structure and produce
 * context that is plausible, cited, and wrong. Prefixed, that join cannot be
 * expressed, which is a stronger guarantee than remembering to check.
 *
 * A lesson with no component is correct and common: the builder's lessons are
 * about the model and the toolchain, not about any file. `null` means "not about
 * one file", never "we failed to work out which file".
 *
 * This is implemented twice, here and in `project_memory/component_key.py`, so
 * FIXTURES below is asserted verbatim by both suites. A format only one side can
 * produce is the original defect wearing a different hat.
 */

export const REPO_NAMESPACE = "repo";
export const BUILD_NAMESPACE = "build";

/** The `identifier` schema's ceiling (`z.string().min(1).max(512)`). */
export const MAX_COMPONENT_LENGTH = 512;

/**
 * Shared across languages. Changing any of these changes the Python twin and
 * both suites in the same commit, or the strata stop joining.
 */
export const COMPONENT_FIXTURES: readonly (readonly [string, string, string])[] = [
  ["repo", "multi-app/providers/gemini.js", "repo:multi-app/providers/gemini.js"],
  ["repo", "project_memory/project_memory/cli.py", "repo:project_memory/project_memory/cli.py"],
  ["build", "build-mtnqt9ug-wtt6v693/src/App.tsx", "build:build-mtnqt9ug-wtt6v693/src/App.tsx"],
];

export interface ParsedComponent {
  readonly namespace: string;
  readonly scope: string;
  readonly path: string;
}

/**
 * A repo-relative POSIX path with no leading `./`, `/`, or backslashes.
 *
 * Producers disagree about all three -- the builder's manifest normalizer strips
 * `./`, a scanner emits native separators -- and two spellings of one file are
 * two components that never meet.
 */
function normalizePath(path: string): string {
  let cleaned = String(path).replace(/\\/g, "/").trim();
  while (cleaned.startsWith("./")) cleaned = cleaned.slice(2);
  return cleaned.replace(/^\/+/, "");
}

function compose(namespace: string, scope: string, path: string): string {
  const cleanScope = String(scope).trim().replace(/^\/+|\/+$/g, "");
  const cleanPath = normalizePath(path);
  if (!cleanScope) throw new Error(`${namespace} component needs a non-empty scope`);
  if (cleanScope.includes("/")) {
    throw new Error(`${namespace} component scope may not contain '/': ${cleanScope}`);
  }
  if (!cleanPath) throw new Error(`${namespace} component needs a non-empty path`);
  const value = `${namespace}:${cleanScope}/${cleanPath}`;
  if (value.length > MAX_COMPONENT_LENGTH) {
    throw new Error(`component exceeds ${MAX_COMPONENT_LENGTH} characters`);
  }
  return value;
}

/** The join key for a file in a first-party repository. */
export function repoComponent(repo: string, path: string): string {
  return compose(REPO_NAMESPACE, repo, path);
}

/** The join key for a file inside one generated application. */
export function buildComponent(buildId: string, path: string): string {
  return compose(BUILD_NAMESPACE, buildId, path);
}

/**
 * The parts of a component key, or null when the value is not one.
 *
 * Null rather than a throw: rows predate this format, and a reader must be able
 * to tell "not a component key" from "malformed" without an exception in the
 * middle of a join.
 */
export function parseComponent(value: unknown): ParsedComponent | null {
  if (typeof value !== "string" || !value.includes(":")) return null;
  const separator = value.indexOf(":");
  const namespace = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  if (namespace !== REPO_NAMESPACE && namespace !== BUILD_NAMESPACE) return null;
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const scope = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (!scope || !path) return null;
  return { namespace, scope, path };
}
