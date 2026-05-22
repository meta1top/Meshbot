"use client";

import type { UserInfo } from "@meshbot/types-agent";
import { atom } from "jotai";
import { atomWithQuery } from "jotai-tanstack-query";
import { fetchProfile, ProfileUnauthorizedError } from "@/rest/auth";

/**
 * profile 查询 atom —— 既是网络请求又是全局状态单一来源。
 *
 * 401（ProfileUnauthorizedError）不重试。组件通过 currentUserAtom /
 * isAuthenticatedAtom 读派生状态。get() 取到的是 react-query 的
 * QueryObserverResult，暴露 data / isPending / isSuccess / error 等字段。
 */
export const profileQueryAtom = atomWithQuery<UserInfo>(() => ({
  queryKey: ["auth", "profile"],
  queryFn: fetchProfile,
  // profile 5 分钟内视为新鲜（与 QueryClient 全局默认一致，此处显式声明）
  staleTime: 5 * 60 * 1000,
  // 401 不重试；其他错误按 QueryClient 全局 retry 次数兜底
  retry: (_failureCount: number, error: Error) =>
    !(error instanceof ProfileUnauthorizedError) &&
    error.name !== "ProfileUnauthorizedError",
}));

/** 当前登录用户；未登录 / 加载中为 null。 */
export const currentUserAtom = atom((get) => {
  const query = get(profileQueryAtom);
  return query.data ?? null;
});

/** 是否已登录（profile 查询成功且有数据）。 */
export const isAuthenticatedAtom = atom((get) => {
  const query = get(profileQueryAtom);
  return query.isSuccess && query.data != null;
});
