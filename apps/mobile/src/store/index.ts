import { atom } from "jotai";

/**
 * 占位客户端状态,示范 jotai 约定。
 *
 * @public-api 数据层预铺 stub,供后续页面接入客户端状态时引用,当前暂无调用方。
 */
export const appReadyAtom = atom(false);
