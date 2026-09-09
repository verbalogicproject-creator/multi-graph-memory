/**
 * The declared taxonomy of the derived stratum.
 *
 * `src/kg` states that it does not own your taxonomy: a graph is typed nodes and
 * typed edges, and *which* types exist is the caller's decision. This file is
 * that caller. Until it existed, `src/kg` was a dormant island -- three files,
 * twelve passing tests, imported by nothing but its own test and not exported
 * from the package -- so the estate carried a working integrity checker and ran
 * it over nothing.
 *
 * Declaring the taxonomy paid for itself immediately. The first run against a
 * real `structure.db` reported 60 `contains` edges running component ->
 * component, when `contains` means "this file holds this component" and can only
 * run file -> component. The ingest had let component nodes claim their file's
 * path in its endpoint index, so every `imports` edge pointing at a module
 * resolved to a component inside it. The graph was complete, self-consistent and
 * wrong, and nothing but a declared endpoint constraint would have said so.
 */

import type { KGSchema } from "../kg/types.ts";

export const STRUCTURE_SCHEMA: KGSchema = {
  name: "code-structure",
  nodeTypes: [
    { name: "file", description: "A source file in the repository." },
    { name: "component", description: "A UI component declared inside a file." },
    {
      name: "external",
      description:
        "Something the graph points at but does not contain: a component or " +
        "hook from a dependency. Named rather than left dangling, so a missing " +
        "edge endpoint always means a scanner defect.",
    },
  ],
  edgeTypes: [
    {
      name: "imports",
      description: "Module-level import, resolved to a file in this repository.",
      weight: 1,
      sourceTypes: ["file"],
      targetTypes: ["file"],
      // Deliberately NOT acyclic: import cycles are legal in this ecosystem and
      // common in practice. Declaring them an integrity error would report a
      // real repository as malformed for doing something the bundler allows.
    },
    {
      name: "contains",
      description: "This file declares this component.",
      weight: 1,
      sourceTypes: ["file"],
      targetTypes: ["component"],
      acyclic: true,
    },
    {
      name: "renders",
      description: "This component renders that one.",
      weight: 1,
      sourceTypes: ["component"],
      targetTypes: ["component", "external"],
    },
    {
      name: "uses_hook",
      description: "This component calls that hook.",
      weight: 1,
      sourceTypes: ["component"],
      targetTypes: ["component", "external", "file"],
    },
  ],
};
