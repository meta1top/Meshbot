#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerStartCommand } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerStatusCommand } from "./commands/status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();
program.name("anybot").description("Anybot Agent CLI").version(pkg.version);

registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);

program.parse();
