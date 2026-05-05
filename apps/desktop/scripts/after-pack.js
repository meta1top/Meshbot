const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const sandboxPath = path.join(context.appOutDir, "chrome-sandbox");
  if (fs.existsSync(sandboxPath)) {
    fs.unlinkSync(sandboxPath);
  }

  const execName = context.packager.appInfo.productFilename;
  const execPath = path.join(context.appOutDir, execName);
  const realExecPath = path.join(context.appOutDir, `${execName}.bin`);

  fs.renameSync(execPath, realExecPath);
  fs.writeFileSync(
    execPath,
    `#!/bin/bash\nexec "$(dirname "$0")/${execName}.bin" --no-sandbox "$@"\n`,
    { mode: 0o755 },
  );
};
