import type { Command } from "commander";
import {
  type CliConfig,
  CONFIG_KEYS,
  getConfigValue,
  isValidConfigKey,
  parseConfigValue,
  setConfigValue,
} from "../utils/config.js";

function rejectUnknownKey(key: string): never {
  console.error(
    `Unknown config key: ${key}. Run \`meshbot config keys\` to list supported keys.`,
  );
  process.exit(1);
}

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage CLI configuration");

  configCmd
    .command("keys")
    .description("List all supported configuration keys")
    .action(() => {
      console.log(
        "Supported config keys (stored in ~/.meshbot/cli-config.json):\n",
      );
      for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
        const current = getConfigValue(key as keyof CliConfig);
        const shown =
          current === undefined || current === null ? "(unset)" : current;
        console.log(`  ${key.padEnd(16)} (${meta.type}) = ${shown}`);
        console.log(`  ${" ".repeat(16)} ${meta.description}`);
      }
    });

  configCmd
    .command("get <key>")
    .description("Get a configuration value")
    .action((key: string) => {
      if (!isValidConfigKey(key)) rejectUnknownKey(key);
      console.log(getConfigValue(key));
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key: string, value: string) => {
      if (!isValidConfigKey(key)) rejectUnknownKey(key);
      let parsed: string | number | boolean;
      try {
        parsed = parseConfigValue(key, value);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      setConfigValue(key, parsed as CliConfig[typeof key]);
      console.log(`Set ${key} = ${parsed}`);
    });
}
