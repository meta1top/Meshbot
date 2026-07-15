"use client";

import { atomWithStorage } from "jotai/utils";

/**
 * 当前选中的 Agent id，持久化到 localStorage。
 *
 * 注意：任何「按 Agent 隔离」的前端状态（会话列表、技能列表、用量……）都必须
 * 按 agentId 分片，或在切换 Agent 时显式失效——本仓库在 usage atom 上栽过
 * 全局单例串台的坑（见 usage-atom-per-session 相关记录）。新增 Agent 维度的
 * atom 时，默认假设它需要 atomFamily(agentId) 或在 currentAgentIdAtom 变化时
 * reset，而不是共享单个全局 atom。
 */
export const currentAgentIdAtom = atomWithStorage<string | null>(
  "meshbot.currentAgentId",
  null,
);
