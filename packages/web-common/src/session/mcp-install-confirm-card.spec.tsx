/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { McpInstallConfirmCard } from "./mcp-install-confirm-card";
import type { ToolCallView } from "./timeline";

/**
 * mcp_install 确认卡：对照 im-send-confirm-card 的状态机（pending/settled）与
 * hitlSettledElsewhere 支持；args 形态 `{ name, server }`，`"command" in server`
 * 判 stdio，否则 http。硬约束：env/headers 只展示 key，不展示值（可能含密钥）。
 */

const HITL_SETTLED_LABEL = "已由其他端应答";

function stdioTool(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: "tc-1",
    name: "mcp_install",
    status: "running",
    args: {
      name: "filesystem",
      server: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
        env: { API_KEY: "super-secret-value" },
      },
    },
    ...overrides,
  };
}

function httpTool(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: "tc-2",
    name: "mcp_install",
    status: "running",
    args: {
      name: "remote",
      server: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer super-secret-token" },
      },
    },
    ...overrides,
  };
}

describe("McpInstallConfirmCard — stdio 形态", () => {
  it("展示 server 名 + command/args 拼接，env 只出 key 不出 value", () => {
    render(
      <McpInstallConfirmCard
        tool={stdioTool()}
        onConfirm={async () => {}}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(
      screen.getByText(
        /npx -y @modelcontextprotocol\/server-filesystem \/path/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/API_KEY/)).toBeInTheDocument();
    // 硬约束：密钥值绝不能出现在 DOM 里
    expect(screen.queryByText(/super-secret-value/)).not.toBeInTheDocument();
  });
});

describe("McpInstallConfirmCard — http 形态", () => {
  it("展示 url + transport（缺省 streamable_http），headers 只出 key 不出 value", () => {
    render(
      <McpInstallConfirmCard
        tool={httpTool()}
        onConfirm={async () => {}}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    expect(screen.getByText("remote")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example\.com\/mcp/)).toBeInTheDocument();
    expect(screen.getByText(/streamable_http/)).toBeInTheDocument();
    expect(screen.getByText(/Authorization/)).toBeInTheDocument();
    expect(screen.queryByText(/super-secret-token/)).not.toBeInTheDocument();
  });

  it("transport 显式指定 sse 时按原样展示，不覆盖为缺省值", () => {
    render(
      <McpInstallConfirmCard
        tool={httpTool({
          args: {
            name: "remote-sse",
            server: { url: "https://example.com/sse", transport: "sse" },
          },
        })}
        onConfirm={async () => {}}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    expect(screen.getByText(/（sse）/)).toBeInTheDocument();
  });
});

describe("McpInstallConfirmCard — 确认/拒绝回调", () => {
  it("点击「确认安装」调 onConfirm(toolCallId, 'send')", async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(
      <McpInstallConfirmCard
        tool={stdioTool()}
        onConfirm={onConfirm}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    fireEvent.click(screen.getByText("确认安装"));
    expect(onConfirm).toHaveBeenCalledWith("tc-1", "send");
  });

  it("点击「拒绝」调 onConfirm(toolCallId, 'cancel')", async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(
      <McpInstallConfirmCard
        tool={stdioTool()}
        onConfirm={onConfirm}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    fireEvent.click(screen.getByText("拒绝"));
    expect(onConfirm).toHaveBeenCalledWith("tc-1", "cancel");
  });
});

describe("McpInstallConfirmCard — settled 态", () => {
  it("result 已落地 status=installed → 展示已安装终态，不再有按钮", () => {
    render(
      <McpInstallConfirmCard
        tool={stdioTool({
          status: "ok",
          result: JSON.stringify({ status: "installed" }),
        })}
        onConfirm={async () => {}}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    expect(screen.getByText(/已安装/)).toBeInTheDocument();
    expect(screen.queryByText("确认安装")).not.toBeInTheDocument();
    expect(screen.queryByText("拒绝")).not.toBeInTheDocument();
  });

  it("result 已落地 status=cancelled → 展示已拒绝终态", () => {
    render(
      <McpInstallConfirmCard
        tool={stdioTool({
          status: "ok",
          result: JSON.stringify({ status: "cancelled" }),
        })}
        onConfirm={async () => {}}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    expect(screen.getByText(/已拒绝/)).toBeInTheDocument();
  });

  it("hitlSettledBy 已设但 result 未落地 → 展示 hitlSettledLabel，收起确认表单", () => {
    render(
      <McpInstallConfirmCard
        tool={stdioTool({ hitlSettledBy: "observer" })}
        onConfirm={async () => {}}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    expect(
      screen.getByText(new RegExp(HITL_SETTLED_LABEL)),
    ).toBeInTheDocument();
    expect(screen.queryByText("确认安装")).not.toBeInTheDocument();
  });

  it("hitlSettledBy 已设、result 也已落地 → 展示真实终态而非占位文案", () => {
    render(
      <McpInstallConfirmCard
        tool={stdioTool({
          status: "ok",
          hitlSettledBy: "local",
          result: JSON.stringify({ status: "installed" }),
        })}
        onConfirm={async () => {}}
        hitlSettledLabel={HITL_SETTLED_LABEL}
      />,
    );
    expect(screen.getByText(/已安装/)).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(HITL_SETTLED_LABEL)),
    ).not.toBeInTheDocument();
  });
});

describe("McpInstallConfirmCard — args 缺失兜底（onToolEnd 兜底建块）", () => {
  it("args 缺失时不崩，降级渲染", () => {
    expect(() =>
      render(
        <McpInstallConfirmCard
          tool={{
            toolCallId: "tc-9",
            name: "mcp_install",
            status: "ok",
            result: JSON.stringify({ status: "installed" }),
          }}
          onConfirm={async () => {}}
          hitlSettledLabel={HITL_SETTLED_LABEL}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText(/已安装/)).toBeInTheDocument();
  });

  it("pending 态 args 缺失（server 未到）时不崩，仅隐去详情块", () => {
    expect(() =>
      render(
        <McpInstallConfirmCard
          tool={{
            toolCallId: "tc-10",
            name: "mcp_install",
            status: "running",
          }}
          onConfirm={async () => {}}
          hitlSettledLabel={HITL_SETTLED_LABEL}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText("确认安装")).toBeInTheDocument();
  });
});
