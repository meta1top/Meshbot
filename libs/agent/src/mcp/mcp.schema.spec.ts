import { McpConfigSchema, isStdioServer } from "./mcp.schema";

describe("McpConfigSchema", () => {
  it("空对象走 default mcpServers={}", () => {
    const r = McpConfigSchema.parse({});
    expect(r.mcpServers).toEqual({});
  });

  it("混合 stdio + http server 都过", () => {
    const r = McpConfigSchema.parse({
      mcpServers: {
        fs: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { FOO: "bar" },
        },
        remote: {
          url: "https://example.com/mcp",
          transport: "sse",
          headers: { Authorization: "Bearer xxx" },
        },
      },
    });
    const fs = r.mcpServers.fs;
    const remote = r.mcpServers.remote;
    expect(isStdioServer(fs)).toBe(true);
    expect(isStdioServer(remote)).toBe(false);
  });

  it("stdio 缺 command 报错", () => {
    expect(() =>
      McpConfigSchema.parse({ mcpServers: { x: { args: ["--help"] } } }),
    ).toThrow();
  });

  it("http url 非法报错", () => {
    expect(() =>
      McpConfigSchema.parse({ mcpServers: { x: { url: "not-a-url" } } }),
    ).toThrow();
  });
});
