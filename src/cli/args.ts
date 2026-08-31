/**
 * Argument parsing, with the prototype's scope vocabulary.
 *
 * `@local` (default), `@workspace:<name>`, `@global` came from the image-studio
 * hive-mind design and read better than raw flags. `@workspace:` requires a
 * federation admission record; `@global` addresses the control tier.
 */

export interface ParsedArgs {
  command: string;
  sub?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  scope: { kind: "local" | "workspace" | "global"; name?: string };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let scope: ParsedArgs["scope"] = { kind: "local" };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "@local" || token === "@current") {
      scope = { kind: "local" };
      continue;
    }
    if (token === "@global" || token === "@cross-project") {
      scope = { kind: "global" };
      continue;
    }
    if (token.startsWith("@workspace:")) {
      scope = { kind: "workspace", name: token.slice("@workspace:".length) };
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }

    positional.push(token);
  }

  return {
    command: positional[0] ?? "",
    ...(positional[1] === undefined ? {} : { sub: positional[1] }),
    positional: positional.slice(1),
    flags,
    scope,
  };
}

export function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagList(flags: ParsedArgs["flags"], name: string): string[] | undefined {
  const value = flagString(flags, name);
  return value === undefined ? undefined : value.split(",").map((s) => s.trim()).filter(Boolean);
}
