/**
 * CLI configuration and cluster layout.
 *
 * Layer 1 -- one SQLite file per project, under .fractal-memory/ in the project
 * root. Layer 2 (the control tier) lives separately in the user's home.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface CliConfig {
  workspace: string;
  projectId: string;
  projectRoot: string;
  clusterDir: string;
  databasePath: string;
  controlDatabasePath: string;
}

export const CONFIG_FILE = ".fractal-memory.json";

export function findProjectRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);
  for (;;) {
    if (
      existsSync(join(current, CONFIG_FILE)) ||
      existsSync(join(current, ".git")) ||
      existsSync(join(current, "package.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

export function loadConfig(overrides: Partial<CliConfig> = {}, startDir = process.cwd()): CliConfig {
  const projectRoot = overrides.projectRoot ?? findProjectRoot(startDir);
  let fileConfig: Partial<CliConfig> = {};

  const configPath = join(projectRoot, CONFIG_FILE);
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as Partial<CliConfig>;
    } catch {
      // A malformed config falls back to defaults rather than blocking the CLI.
    }
  }

  const projectId = overrides.projectId ?? fileConfig.projectId ?? basename(projectRoot);
  const workspace = overrides.workspace ?? fileConfig.workspace ?? process.env.FRACTAL_WORKSPACE ?? "default";
  const clusterDir = overrides.clusterDir ?? fileConfig.clusterDir ?? join(projectRoot, ".fractal-memory");

  return {
    workspace,
    projectId,
    projectRoot,
    clusterDir,
    databasePath: overrides.databasePath ?? fileConfig.databasePath ?? join(clusterDir, `${projectId}.db`),
    controlDatabasePath:
      overrides.controlDatabasePath ??
      fileConfig.controlDatabasePath ??
      join(process.env.FRACTAL_MEMORY_HOME ?? join(homedir(), ".fractal-memory"), "control.db"),
  };
}

export function ensureClusterDir(config: CliConfig): void {
  mkdirSync(config.clusterDir, { recursive: true });
}
