#!/usr/bin/env node
import { detectMain } from "./index.js";

detectMain(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), cwd: process.cwd() }).then((code) => {
  process.exitCode = code;
});
