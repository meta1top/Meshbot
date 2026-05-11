import type { Command } from "commander";
import {
  type CliConfig,
  getConfigValue,
  setConfigValue,
} from "../utils/config.js";

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage CLI configuration");

  configCmd
    .command("get <key>")
    .description("Get a configuration value")
    .action((key: string) => {
      const value = getConfigValue(key as keyof CliConfig);
      console.log(value);
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key: string, value: string) => {
      const numValue = Number(value);
      const finalValue = Number.isNaN(numValue) ? value : numValue;
      setConfigValue(
        key as keyof CliConfig,
        finalValue as CliConfig[keyof CliConfig],
      );
      console.log(`Set ${key} = ${value}`);
    });
}
