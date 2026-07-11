/**
 * socket.io-client 的 jest CJS stub。
 *
 * 真包是 ESM-only（export map 无 CJS 入口），ts-jest（CommonJS）解析必崩
 * `Cannot find module 'socket.io-client'`，拖垮 server-agent 5 个 suite 的
 * import 链（remote-device-query + 4 个 e2e）。同 @vscode/ripgrep stub 先例。
 *
 * 只需满足被 import 的符号：`{ type Socket, io }`（im-relay-client.service.ts）。
 * Socket 是纯类型不需要运行时值；io() 返回惰性 no-op socket——相关 suite 均
 * mock 掉上层 service，不会真正驱动 socket 行为。
 */
const noopSocket = {
  on: () => noopSocket,
  once: () => noopSocket,
  off: () => noopSocket,
  emit: () => noopSocket,
  connect: () => noopSocket,
  disconnect: () => noopSocket,
  close: () => noopSocket,
  removeAllListeners: () => noopSocket,
  connected: false,
};
module.exports = { io: () => noopSocket };
