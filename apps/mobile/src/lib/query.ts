import { QueryClient } from "@tanstack/react-query";

/** 全局 QueryClient 单例(与 web-agent 的服务端状态约定对齐)。 */
export const queryClient = new QueryClient();
