#!/usr/bin/env node
import { desktopMain } from "./index.js";

desktopMain(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env, cwd: process.cwd() }).then((code) => {
  process.exitCode = code;
});
