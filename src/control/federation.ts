/**
 * Federated reads across clusters (Ruling 5).
 *
 * A cross-project read requires an admission record held in the CONTROL tier,
 * not in a cluster -- a cluster must not be able to widen its own scope by
 * writing to its own database.
 *
 * Each cluster is opened and queried under its OWN strict scope. There is no
 * "query everything" path: the admission names the workspaces, the registry
 * names the clusters, and anything not named is simply never opened.
 */

import { SqliteStorageAdapter } from "../adapters/sqlite.ts";
import { admits, assertAdmissionValid } from "../core/scope.ts";
import { refuse } from "../core/errors.ts";
import { GraphMemory, type ContextRequest } from "../port.ts";
import type { ContextPacket, FederationAdmission } from "../core/types.ts";
import type { ControlStore } from "./registry.ts";

export interface FederatedResult {
  packets: Array<{ projectId: string; packet: ContextPacket }>;
  admission: FederationAdmission;
  consulted: string[];
  refused: Array<{ projectId: string; reason: string }>;
}

/**
 * Reads across every registered project the admission actually permits.
 * Returns one packet per project, kept separate: merging them would blur which
 * project a claim came from, and provenance is the point.
 */
/**
 * Declared `async` deliberately. An earlier version validated the admission
 * before entering an async body, so it could throw SYNCHRONOUSLY while
 * advertising a Promise -- a caller using `.catch()` would have taken an
 * uncaught exception instead. A function that returns a Promise must always
 * reject, never throw.
 */
export async function federatedQuery(
  control: ControlStore,
  workspace: string,
  request: ContextRequest,
): Promise<FederatedResult> {
  const stored = control.getAdmission(workspace);
  if (!stored) {
    refuse(
      "FEDERATION_NOT_ADMITTED",
      `No federation admission recorded for workspace "${workspace}". Record one with \`fractal-memory admit\`.`,
      { workspace },
    );
  }
  const admission = assertAdmissionValid(stored);

  const consulted: string[] = [];
  const refused: Array<{ projectId: string; reason: string }> = [];
  const projects = control.listProjects();

  const packets: FederatedResult["packets"] = [];

  for (const project of projects) {
    if (!admits(admission, project.workspace, project.projectId)) {
      refused.push({ projectId: project.projectId, reason: "not named in the admission record" });
      continue;
    }

    const storage = new SqliteStorageAdapter({ path: project.databasePath });
    try {
      storage.open();
      const memory = new GraphMemory({
        storage,
        scope: { workspace: project.workspace, projectId: project.projectId },
      });
      packets.push({ projectId: project.projectId, packet: await memory.queryContext(request) });
      consulted.push(project.projectId);
    } catch (error) {
      refused.push({
        projectId: project.projectId,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      storage.close();
    }
  }

  return { packets, admission, consulted, refused };
}
