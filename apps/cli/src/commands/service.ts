import type { Command } from "commander";
import {
  installService,
  uninstallService,
} from "../utils/service-installer.js";

export function registerServiceCommand(program: Command): void {
  const serviceCmd = program
    .command("service")
    .description("Manage system service");

  serviceCmd
    .command("install")
    .description("Register Agent as a system service")
    .option("--user", "Install as user service (no root required)", true)
    .action((options) => {
      try {
        installService(options.user);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  serviceCmd
    .command("uninstall")
    .description("Unregister Agent system service")
    .option("--user", "Uninstall user service", true)
    .action((options) => {
      try {
        uninstallService(options.user);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
