#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerConfigCommand } from "./commands/config-cmd.js";
import { registerServiceCommand } from "./commands/service.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStopCommand } from "./commands/stop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
);

const program = new Command();
program.name("meshbot").description("MeshBot Agent CLI").version(pkg.version);

registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerServiceCommand(program);
registerConfigCommand(program);

program.parse();
