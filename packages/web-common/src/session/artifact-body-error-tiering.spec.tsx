/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import {
  ArtifactBody,
  type ArtifactBodyLabels,
  classifyRemoteArtifactError,
  resolveLoadFailedText,
} from "./artifact-body";

// react-markdown 是纯 ESM，jest CJS 转译链吃不下（同
// message-list-error-reason.spec.tsx 的既有做法）；本用例只关心错误态文案，
// markdown 正文渲染无关紧要 → 桩掉整个 markdown-content 模块。
jest.mock("./markdown-content", () => ({
  MarkdownContent: ({ text }: { text: string }) => <span>{text}</span>,
}));

/**
 * 真机验收缺陷 3：`packages/web-common/src/session/artifact-body.tsx` 曾把
 * 「transport 缺失（无数据源）/ 远程链路失败 / 本机 404」三类完全不同的失败
 * 塞进同一个 `err` 布尔，统一显示「产物已不存在或已变更」——正是这句混淆过
 * 一次「打错了机器的 404」和「文件真没了」，把排查方向带偏到设备白名单上，
 * 浪费了一整轮真机验收。本文件覆盖：
 * 1. `classifyRemoteArtifactError` 的分类边界（纯函数，直接测）；
 * 2. `resolveLoadFailedText` 的回退语义（未提供细分文案时退回通用 loadFailed）；
 * 3. `ArtifactBody` 端到端渲染出的文案确实按四态分叉（不是内部状态对了、
 *    UI 没接上——之前就踩过"变异等价于原实现"的坑，这里直接断言可见文本）。
 */

const LABELS: ArtifactBodyLabels = {
  loading: "加载中",
  loadFailed: "GENERIC_LOAD_FAILED",
  loadFailedNoSource: "LABEL_NO_SOURCE",
  loadFailedRemoteRejected: "LABEL_REMOTE_REJECTED",
  loadFailedRemoteUnreachable: "LABEL_REMOTE_UNREACHABLE",
  unsupported: "不支持预览",
  tooLarge: (size) => `文件过大 ${size}MB`,
  uploadFailed: "上传失败",
  uploading: "上传中",
  uploadToDrive: "上传到网盘",
  previewTitle: "预览",
  imageAlt: "产物",
};

/** 只提供通用 loadFailed（模拟 web-main 暂未跟进细分文案的调用方）。 */
const LABELS_NO_TIERING: ArtifactBodyLabels = {
  loading: "加载中",
  loadFailed: "GENERIC_LOAD_FAILED",
  unsupported: "不支持预览",
  tooLarge: (size) => `文件过大 ${size}MB`,
  uploadFailed: "上传失败",
  uploading: "上传中",
  uploadToDrive: "上传到网盘",
  previewTitle: "预览",
  imageAlt: "产物",
};

describe("classifyRemoteArtifactError（远程产物加载失败的分类边界）", () => {
  it("504（REMOTE_QUERY_TIMEOUT，等不到对端响应）→ remoteUnreachable", () => {
    expect(classifyRemoteArtifactError({ response: { status: 504 } })).toBe(
      "remoteUnreachable",
    );
  });

  it("409（REMOTE_QUERY_UNAVAILABLE，对端给出明确失败结果）→ remoteRejected", () => {
    expect(classifyRemoteArtifactError({ response: { status: 409 } })).toBe(
      "remoteRejected",
    );
  });

  it("503（IM_NOT_CONNECTED：本机自己 relay 断线）→ remoteUnreachable，绝不能说成「对端拒绝」", () => {
    // review 抓出的误诊：原规则是「除 504 外任何 status → 拒绝」，而 503 由
    // 本机 relay 断线抛出、与对端无关。说成「对方设备拒绝」会让用户跑去对端
    // 查白名单——这个分级本身就是为消除误诊而做的，不能自己再制造一次。
    expect(classifyRemoteArtifactError({ response: { status: 503 } })).toBe(
      "remoteUnreachable",
    );
  });

  it("非 409 非 5xx 的显式状态（如 403/401）→ unknown（本机服务器拒了请求，不猜是谁的问题）", () => {
    expect(classifyRemoteArtifactError({ response: { status: 403 } })).toBe(
      "unknown",
    );
    expect(classifyRemoteArtifactError({ response: { status: 401 } })).toBe(
      "unknown",
    );
  });

  it("没有 response（网络层失败，没拿到任何响应）→ remoteUnreachable", () => {
    expect(classifyRemoteArtifactError(new Error("Network Error"))).toBe(
      "remoteUnreachable",
    );
  });

  it("err 本身是 null/undefined（防御性）→ remoteUnreachable", () => {
    expect(classifyRemoteArtifactError(null)).toBe("remoteUnreachable");
    expect(classifyRemoteArtifactError(undefined)).toBe("remoteUnreachable");
  });
});

describe("resolveLoadFailedText（未提供细分文案时回退通用 loadFailed）", () => {
  it("四态都提供细分文案时 → 各自独立，互不相同", () => {
    const texts = new Set([
      resolveLoadFailedText(LABELS, "noSource"),
      resolveLoadFailedText(LABELS, "remoteRejected"),
      resolveLoadFailedText(LABELS, "remoteUnreachable"),
      resolveLoadFailedText(LABELS, "notFound"),
    ]);
    expect(texts.size).toBe(4);
  });

  it("notFound 态本就只用通用 loadFailed（不额外开专属键）", () => {
    expect(resolveLoadFailedText(LABELS, "notFound")).toBe(
      "GENERIC_LOAD_FAILED",
    );
  });

  it("调用方未提供细分文案（如 web-main）→ 三态全部回退通用 loadFailed，不是 undefined/空串", () => {
    expect(resolveLoadFailedText(LABELS_NO_TIERING, "noSource")).toBe(
      "GENERIC_LOAD_FAILED",
    );
    expect(resolveLoadFailedText(LABELS_NO_TIERING, "remoteRejected")).toBe(
      "GENERIC_LOAD_FAILED",
    );
    expect(resolveLoadFailedText(LABELS_NO_TIERING, "remoteUnreachable")).toBe(
      "GENERIC_LOAD_FAILED",
    );
  });
});

describe("ArtifactBody 端到端渲染：四态文案确实分叉（不只是内部状态对了）", () => {
  const remote = { deviceId: "device-b", sessionId: "s1" };
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("remote 产物但未注入 transport（无数据源）→ 渲染 LABEL_NO_SOURCE，不是通用文案", async () => {
    render(
      <ArtifactBody
        path="a.md"
        remote={remote}
        labels={LABELS}
        // transport 故意不传
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("LABEL_NO_SOURCE")).toBeInTheDocument(),
    );
    expect(screen.queryByText("GENERIC_LOAD_FAILED")).not.toBeInTheDocument();
    // 无数据源分支根本没发请求：不该有任何 console.error（没有 error 对象可打）
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("远程 transport 返回 409（明确拒绝）→ 渲染 LABEL_REMOTE_REJECTED，并保留原始 error 到 console.error", async () => {
    const originalError = { response: { status: 409 }, message: "unavailable" };
    const transport = {
      readArtifact: jest.fn().mockRejectedValue(originalError),
      uploadArtifactToDrive: jest.fn(),
    };
    render(
      <ArtifactBody
        path="a.md"
        remote={remote}
        labels={LABELS}
        transport={transport}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("LABEL_REMOTE_REJECTED")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("LABEL_REMOTE_UNREACHABLE"),
    ).not.toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("远程产物加载失败"),
      originalError,
    );
  });

  it("远程 transport 返回 504（超时）→ 渲染 LABEL_REMOTE_UNREACHABLE", async () => {
    const transport = {
      readArtifact: jest.fn().mockRejectedValue({ response: { status: 504 } }),
      uploadArtifactToDrive: jest.fn(),
    };
    render(
      <ArtifactBody
        path="a.md"
        remote={remote}
        labels={LABELS}
        transport={transport}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("LABEL_REMOTE_UNREACHABLE")).toBeInTheDocument(),
    );
  });

  it("本机 fetchLocal 404（文件不存在）→ 渲染通用 loadFailed（notFound 复用它，不是远程文案）", async () => {
    const fetchLocal = jest
      .fn()
      .mockRejectedValue({ response: { status: 404 } });
    render(
      <ArtifactBody path="a.md" labels={LABELS} fetchLocal={fetchLocal} />,
    );
    await waitFor(() =>
      expect(screen.getByText("GENERIC_LOAD_FAILED")).toBeInTheDocument(),
    );
    expect(screen.queryByText("LABEL_NO_SOURCE")).not.toBeInTheDocument();
    expect(screen.queryByText("LABEL_REMOTE_REJECTED")).not.toBeInTheDocument();
    expect(
      screen.queryByText("LABEL_REMOTE_UNREACHABLE"),
    ).not.toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("本机产物加载失败"),
      expect.anything(),
    );
  });
});
