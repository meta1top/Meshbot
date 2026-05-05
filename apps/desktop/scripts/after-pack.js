const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const resourcesDir = path.join(context.appOutDir, "resources");
  const serverAgentDest = path.join(resourcesDir, "server-agent", "node_modules");

  if (!fs.existsSync(serverAgentDest)) {
    const bundleSrc = path.resolve(
      context.packager.projectDir,
      "../server-agent/.bundle/node_modules",
    );
    fs.cpSync(bundleSrc, serverAgentDest, { recursive: true, dereference: true });
  }

  if (context.electronPlatformName !== "linux") return;

  const sandboxPath = path.join(context.appOutDir, "chrome-sandbox");
  if (fs.existsSync(sandboxPath)) {
    fs.unlinkSync(sandboxPath);
  }

  const execName = context.packager.executableName;
  const execPath = path.join(context.appOutDir, execName);
  const realExecPath = path.join(context.appOutDir, `${execName}.bin`);

  if (!fs.existsSync(execPath)) return;

  fs.renameSync(execPath, realExecPath);
  fs.writeFileSync(
    execPath,
    `#!/bin/bash\nexec "$(dirname "$0")/${execName}.bin" --no-sandbox "$@"\n`,
    { mode: 0o755 },
  );
};
