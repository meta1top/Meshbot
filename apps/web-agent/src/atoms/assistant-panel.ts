import { QUICK_ASSISTANT_DEFAULT_NAME } from "@meshbot/types-agent";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/** 顶栏 ✦ 控制的随手问面板开关（全局）。localStorage 持久化：刷新前开着，刷新后仍开。 */
export const assistantPanelOpenAtom = atomWithStorage(
  "meshbot.assistantPanelOpen",
  false,
);

/** 随手问当前名字（dock 标题）。默认回退默认名；dock 打开时从 REST 拉取，ws renamed 事件实时更新。 */
export const quickAssistantNameAtom = atom<string>(
  QUICK_ASSISTANT_DEFAULT_NAME,
);

/** 面板当前随手问会话 id；null = 尚未开始（首条消息惰性创建）。 */
export const currentQuickSessionIdAtom = atom<string | null>(null);

/** 产物预览 aside 宽度（px）：xl 下停靠分栏时左缘可拖拽，localStorage 持久化。 */
export const assistantPanelWidthAtom = atomWithStorage(
  "meshbot.assistantPanelWidth",
  340,
);

/**
 * 随手问全高浮层面板宽度（px）：左缘可拖拽，localStorage 持久化。
 * null = 尚未手动调过 → 用默认 30% 窗宽（最小 380px）；调过后存具体 px。
 */
export const assistantDockWidthAtom = atomWithStorage<number | null>(
  "meshbot.assistantDockWidth",
  null,
);

/** 右侧面板当前内容：助手 or 产物预览。 */
export const assistantPanelTypeAtom = atom<"assistant" | "preview">(
  "assistant",
);

/** 当前预览的产物。两种来源互斥：
 * - 产物源：`path`（server-agent workspace 相对路径，经 apiClient 带 token 拉取）
 * - 网盘源：`url`（presigned URL，裸 fetch 自带凭证）+ `name`（文件名，用于类型判断和下载名）
 */
export interface PreviewArtifact {
  /** server-agent 产物相对路径（apiClient 带 token）。 */
  path?: string;
  /** 远程设备产物：path 为 B 设备工作区相对路径，经设备查询通道读取。 */
  remote?: { deviceId: string; sessionId: string };
  /** 网盘 presigned URL（裸 fetch，自带凭证，不带 apiClient token）。 */
  url?: string;
  /** 文件名（presigned 源用它判类型 + 下载名）。 */
  name?: string;
  title?: string;
}
export const previewArtifactAtom = atom<PreviewArtifact | null>(null);

/** 产物预览是否处于全屏：全屏时隐藏顶栏助手 ✦ 按钮，避免与全屏 modal 重叠。 */
export const artifactFullscreenAtom = atom(false);
