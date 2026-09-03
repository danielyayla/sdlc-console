#!/usr/bin/env node
import { main } from "./main.js";

const io = {
  stdout: (t: string) => process.stdout.write(t),
  stderr: (t: string) => process.stderr.write(t),
  stdin: () =>
    new Promise<string>((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c: string) => (data += c));
      process.stdin.on("end", () => resolve(data));
    }),
  env: process.env,
  cwd: process.cwd(),
};

main(process.argv.slice(2), io).then((code) => {
  process.exitCode = code;
});
