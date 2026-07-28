import { describe, expect, it } from "vitest";
import {
  buildLlmuseGuide,
  LLMUSE_BLOCK_INTRO,
  LLMUSE_IM_TOOLS,
} from "./llmuse-guide";

describe("buildLlmuseGuide", () => {
  it("全启（空禁用集）：intro + 三个工具指引行，标点收尾干净", () => {
    const guide = buildLlmuseGuide(new Set());
    expect(guide).toContain(LLMUSE_BLOCK_INTRO);
    expect(guide).toContain("当你需要更深入的信息时，调用 IM 工具：");
    expect(guide).toBe(
      [
        LLMUSE_BLOCK_INTRO,
        "",
        "当你需要更深入的信息时，调用 IM 工具：",
        "- im_unread_overview：列出所有会话与未读数；",
        "- im_read_conversation：按 id 读某频道/私聊的最近消息；",
        "- im_list_members：列出某频道成员。",
      ].join("\n"),
    );
  });

  it("部分禁用（禁 im_list_members）：只省略被禁的那一行，剩余行标点收尾干净（末行改句号）", () => {
    const guide = buildLlmuseGuide(new Set(["im_list_members"]));
    expect(guide).not.toContain("im_list_members");
    expect(guide).toBe(
      [
        LLMUSE_BLOCK_INTRO,
        "",
        "当你需要更深入的信息时，调用 IM 工具：",
        "- im_unread_overview：列出所有会话与未读数；",
        "- im_read_conversation：按 id 读某频道/私聊的最近消息。",
      ].join("\n"),
    );
  });

  it("部分禁用（禁开头的 im_unread_overview）：剩余行不留孤立标点/空行", () => {
    const guide = buildLlmuseGuide(new Set(["im_unread_overview"]));
    expect(guide).not.toContain("im_unread_overview");
    expect(guide).toBe(
      [
        LLMUSE_BLOCK_INTRO,
        "",
        "当你需要更深入的信息时，调用 IM 工具：",
        "- im_read_conversation：按 id 读某频道/私聊的最近消息；",
        "- im_list_members：列出某频道成员。",
      ].join("\n"),
    );
  });

  it("全禁（三个 IM 工具全在禁用集里）：只剩 intro，整段工具指引省略，无孤立标点/空行", () => {
    const guide = buildLlmuseGuide(new Set(LLMUSE_IM_TOOLS));
    expect(guide).toBe(LLMUSE_BLOCK_INTRO);
    expect(guide).not.toContain("调用 IM 工具");
    expect(guide).not.toContain("im_unread_overview");
    expect(guide.endsWith("\n")).toBe(false);
  });

  it("禁用集包含无关工具名：不影响三个 IM 工具行的呈现（无关名不匹配不生效）", () => {
    const guide = buildLlmuseGuide(new Set(["bash", "write_file"]));
    expect(guide).toBe(buildLlmuseGuide(new Set()));
  });
});
