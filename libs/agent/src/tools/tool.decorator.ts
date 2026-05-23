import { Injectable, applyDecorators } from "@nestjs/common";

export const TOOL_METADATA_KEY = Symbol("meshbot:tool");

/**
 * 标记一个类为 meshbot tool。配合 MeshbotTool 接口使用：
 * ```
 * @Tool()
 * export class BashTool implements MeshbotTool<...> { ... }
 * ```
 * 装饰器自带 @Injectable() —— ToolRegistry 启动时扫描所有 provider 找带
 * 此 metadata 的实例并注册。
 */
export function Tool(): ClassDecorator {
  return applyDecorators(Injectable(), (target: object) => {
    Reflect.defineMetadata(TOOL_METADATA_KEY, true, target);
  });
}
