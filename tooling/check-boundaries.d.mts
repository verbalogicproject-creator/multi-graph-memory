/**
 * Types for the boundary policy, so `test/boundaries.policy.test.ts` can assert
 * against the real decision rather than a copy of it.
 */
export declare const CORE_ALLOWED_PACKAGES: Set<string>;
export declare const CORE_TYPE_ONLY_SEAM: Set<string>;
export declare const FORBIDDEN_IN_CORE: ReadonlyArray<{ pattern: RegExp; why: string }>;
export declare function importsOf(rawSource: string): Array<{ spec: string; typeOnly: boolean }>;
/** Every boundary violation in one file, as human-readable lines. */
export declare function violationsFor(rel: string, source: string): string[];
