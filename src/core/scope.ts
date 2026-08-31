/**
 * Ruling 5: strict project isolation, failing closed.
 *
 * Every query carries an explicit project scope. A cross-project read requires
 * federated mode AND a non-empty admission record naming an approver, a purpose
 * and allowed workspaces. There is no fallback path: a missing scope is a
 * refusal, never a silent widening to "everything".
 *
 * An admission is retrieval policy and provenance. It is never an authority grant.
 */

import { refuse } from "./errors.ts";
import { federationAdmissionSchema } from "./schema.ts";
import type { FederationAdmission, ProjectScope, RetrievalMode } from "./types.ts";

export interface ResolvedScope {
  mode: RetrievalMode;
  workspace: string;
  /** Present in strict mode. Absent in federated mode, where the admission bounds the read. */
  projectId?: string;
  admission?: FederationAdmission;
}

export function requireScope(scope: Partial<ProjectScope> | undefined | null): ProjectScope {
  if (!scope || typeof scope.projectId !== "string" || scope.projectId.length === 0) {
    refuse(
      "SCOPE_REQUIRED",
      "Every Graph Memory query requires an explicit project scope. Unscoped retrieval is refused.",
      { received: scope ?? null },
    );
  }
  const workspace = typeof scope.workspace === "string" && scope.workspace.length > 0 ? scope.workspace : "default";
  return { workspace, projectId: scope.projectId };
}

/** Guards a record read or written under a scope against belonging to another project. */
export function assertProjectMatch(recordProjectId: string, scope: ProjectScope, what = "record"): void {
  if (recordProjectId !== scope.projectId) {
    refuse(
      "PROJECT_MISMATCH",
      `Refused: ${what} belongs to project "${recordProjectId}" but the active scope is "${scope.projectId}".`,
      { recordProjectId, scopeProjectId: scope.projectId, what },
    );
  }
}

export function assertAdmissionValid(admission: unknown): FederationAdmission {
  const parsed = federationAdmissionSchema.safeParse(admission);
  if (!parsed.success) {
    refuse("FEDERATION_NOT_ADMITTED", "A cross-project read requires a complete admission record.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/**
 * Resolves a retrieval request into the scope it may actually read.
 * Strict is the default everywhere; federated must be asked for explicitly.
 */
export function resolveRetrieval(
  scope: Partial<ProjectScope> | undefined,
  mode: RetrievalMode = "strict",
  admission?: unknown,
): ResolvedScope {
  if (mode === "strict") {
    const resolved = requireScope(scope);
    return { mode: "strict", workspace: resolved.workspace, projectId: resolved.projectId };
  }

  const admitted = assertAdmissionValid(admission);
  const workspace = scope?.workspace ?? admitted.allowedWorkspaces[0] ?? "default";
  if (!admitted.allowedWorkspaces.includes(workspace)) {
    refuse(
      "FEDERATION_NOT_ADMITTED",
      `Workspace "${workspace}" is not named in the admission record.`,
      { workspace, allowedWorkspaces: admitted.allowedWorkspaces },
    );
  }
  return { mode: "federated", workspace, admission: admitted };
}

/** Whether a federated read may include a given project. */
export function admits(admission: FederationAdmission, workspace: string, projectId: string): boolean {
  if (!admission.allowedWorkspaces.includes(workspace)) return false;
  if (admission.allowedProjects && !admission.allowedProjects.includes(projectId)) return false;
  return true;
}

/**
 * Ruling 5: importing a bundle into a different project refuses unless an explicit
 * re-home was human-approved and is recorded.
 */
export interface RehomeApproval {
  approvedBy: string;
  reason: string;
  fromProjectId: string;
  toProjectId: string;
  approvedAt: string;
}

export function assertRehomeApproved(
  fromProjectId: string,
  toProjectId: string,
  approval?: RehomeApproval,
): void {
  if (fromProjectId === toProjectId) return;
  if (
    !approval ||
    approval.fromProjectId !== fromProjectId ||
    approval.toProjectId !== toProjectId ||
    !approval.approvedBy ||
    !approval.reason
  ) {
    refuse(
      "REHOME_NOT_APPROVED",
      `Importing project "${fromProjectId}" data into "${toProjectId}" requires a recorded, human-approved re-home.`,
      { fromProjectId, toProjectId },
    );
  }
}
