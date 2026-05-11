import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function getCliPath(): string {
  return process.argv[1];
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function installService(userOnly = true): void {
  const cliPath = getCliPath();

  if (process.platform === "darwin") {
    const plistDir = path.join(homedir(), "Library", "LaunchAgents");
    ensureDir(plistDir);
    const plistPath = path.join(plistDir, "com.meshbot.agent.plist");

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.meshbot.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cliPath}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(homedir(), ".meshbot", "logs", "agent.stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(homedir(), ".meshbot", "logs", "agent.stderr.log")}</string>
</dict>
</plist>`;

    writeFileSync(plistPath, plist, "utf8");
    execSync(`launchctl load ${plistPath}`);
    console.log(
      "Service installed. Use `launchctl start com.meshbot.agent` to start.",
    );
  } else if (process.platform === "linux") {
    const systemdDir = userOnly
      ? path.join(homedir(), ".config", "systemd", "user")
      : "/etc/systemd/system";
    ensureDir(systemdDir);
    const servicePath = path.join(systemdDir, "meshbot-agent.service");

    const service = `[Unit]
Description=MeshBot Agent
After=network.target

[Service]
Type=simple
ExecStart=${cliPath} start --daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;

    writeFileSync(servicePath, service, "utf8");
    const scope = userOnly ? "--user" : "";
    execSync(`systemctl ${scope} daemon-reload`);
    execSync(`systemctl ${scope} enable meshbot-agent`);
    console.log(
      "Service installed. Use `systemctl --user start meshbot-agent` to start.",
    );
  } else if (process.platform === "win32") {
    try {
      execSync(
        `sc create MeshBotAgent binPath= "${cliPath} start --daemon" start= auto`,
        {
          stdio: "inherit",
        },
      );
      console.log("Service installed. Use `sc start MeshBotAgent` to start.");
    } catch (err) {
      console.error(
        "Failed to install Windows service. Try running as Administrator.",
      );
      throw err;
    }
  }
}

export function uninstallService(userOnly = true): void {
  if (process.platform === "darwin") {
    const plistPath = path.join(
      homedir(),
      "Library",
      "LaunchAgents",
      "com.meshbot.agent.plist",
    );
    if (existsSync(plistPath)) {
      execSync(`launchctl unload ${plistPath}`);
      unlinkSync(plistPath);
    }
    console.log("Service uninstalled.");
  } else if (process.platform === "linux") {
    const systemdDir = userOnly
      ? path.join(homedir(), ".config", "systemd", "user")
      : "/etc/systemd/system";
    const servicePath = path.join(systemdDir, "meshbot-agent.service");
    const scope = userOnly ? "--user" : "";
    try {
      execSync(`systemctl ${scope} disable meshbot-agent`);
      execSync(`systemctl ${scope} stop meshbot-agent`);
    } catch {
      // ignore
    }
    if (existsSync(servicePath)) {
      unlinkSync(servicePath);
    }
    execSync(`systemctl ${scope} daemon-reload`);
    console.log("Service uninstalled.");
  } else if (process.platform === "win32") {
    try {
      execSync(`sc stop MeshBotAgent`, { stdio: "ignore" });
      execSync(`sc delete MeshBotAgent`, { stdio: "inherit" });
      console.log("Service uninstalled.");
    } catch (err) {
      console.error("Failed to uninstall Windows service.");
      throw err;
    }
  }
}
