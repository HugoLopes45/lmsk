#!/usr/bin/env node
import { homedir } from "node:os";
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  home: homedir(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
