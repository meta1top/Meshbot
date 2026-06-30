import type { Command } from "commander";
import { startAgent } from "../utils/process-manager.js";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the Agent service")
    .option(
      "-p, --port <number>",
      "Port to listen on (default: auto-detect 7727)",
    )
    .option("-d, --data-dir <path>", "Data directory")
    .option("--daemon", "Run in background")
    .action(async (options) => {
      try {
        await startAgent({
          port: options.port ? Number(options.port) : undefined,
          dataDir: options.dataDir,
          daemon: options.daemon,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
