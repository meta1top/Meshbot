#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program.name("anybot").description("Anybot CLI Agent").version("0.0.1");

program.parse();
