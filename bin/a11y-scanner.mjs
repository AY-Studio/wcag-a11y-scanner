#!/usr/bin/env node
import { runCli } from '../src/cli.mjs';

runCli(process.argv).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
