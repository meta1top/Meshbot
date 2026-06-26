// jest 桩：@vscode/ripgrep 是 ESM-only 包，jest（CommonJS / ts-jest）直接 require
// 其 lib/index.js 会报「Cannot use import statement outside a module」。
//
// jest 并不运行 grep 相关测试（grep.tool 在 libs/agent，走 vitest 且被
// testPathIgnorePatterns 排除），只是会因模块图被「传递 import」到 @vscode/ripgrep。
// 因此给一个永远不会被实际 spawn 调用的 rgPath 占位即可，解开这条 import 链。
module.exports = { rgPath: "rg" };
