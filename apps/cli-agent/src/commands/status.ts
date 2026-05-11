import type { Command } from "commander";
import { getAgentStatus } from "../utils/process-manager.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show Agent service status")
    .action(async () => {
      await getAgentStatus();
    });
}
