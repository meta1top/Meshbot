import type { Command } from "commander";
import { stopAgent } from "../utils/process-manager.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the Agent service")
    .action(() => {
      stopAgent();
    });
}
