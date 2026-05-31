import * as x from "./x.js";

const REGISTRY = { x };

/** 按 --site 取平台适配器；未知则报错列出支持项。 */
export function resolvePlatform(site) {
  const p = REGISTRY[site];
  if (!p)
    throw new Error(
      `未知 --site=${site}；支持：${Object.keys(REGISTRY).join(", ")}`,
    );
  return p;
}
