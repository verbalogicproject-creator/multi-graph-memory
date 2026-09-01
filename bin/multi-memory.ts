#!/usr/bin/env node
import { main } from "../src/cli/multi-memory.ts";

main().then((code) => {
  process.exitCode = code;
});
