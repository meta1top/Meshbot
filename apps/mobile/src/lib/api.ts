import axios from "axios";

/**
 * 全局 axios 客户端。baseURL 走 Expo 公有环境变量 `EXPO_PUBLIC_API_BASE_URL`。
 * 鉴权 header 注入留待后续(本期不实现登录/鉴权)。
 *
 * @public-api 数据层预铺 stub,供后续页面接入网络请求时引用,当前暂无调用方。
 */
export const apiClient = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_BASE_URL ?? "",
});
