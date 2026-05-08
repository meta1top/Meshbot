import { Command } from "commander";
import { readConfig, setConfigValue, getConfigValue } from "../utils/config.js";

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command("config").description("Manage CLI configuration");

  configCmd
    .command("get <key>")
    .description("Get a configuration value")
    .action((key: string) => {
      const value = getConfigValue(key as keyof typeof readConfig extends infer R ? R : never);
      console.log(value);
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key: string, value: string) => {
      const numValue = Number(value);
      const finalValue = Number.isNaN(numValue) ? value : numValue;
      setConfigValue(key as any, finalValue as any);
      console.log(`Set ${key} = ${value}`);
    });
}
