#!/usr/bin/env node
import { main } from "../src/cli/fractal-memory.ts";

main().then((code) => {
  process.exitCode = code;
});
