import { load } from "js-yaml";
import { NacosConfigClient } from "nacos";
import type { NacosBootstrap } from "./nacos-bootstrap.schema";

/** 从 Nacos 配置中心拉取配置（dataId 内容为 YAML），解析成嵌套对象。 */
export async function loadNacosConfig(
  bootstrap: NacosBootstrap,
): Promise<Record<string, unknown>> {
  const { serverAddr, namespace, group, dataId, username, password } =
    bootstrap;
  const client = new NacosConfigClient({
    serverAddr,
    namespace,
    ...(username && password ? { username, password } : {}),
  });
  const where = `server=${serverAddr} namespace=${namespace} group=${group} dataId=${dataId}`;

  let content: string | null;
  try {
    await client.ready();
    content = await client.getConfig(dataId, group);
  } catch (err) {
    throw new Error(
      `[config-loader] 从 Nacos 拉取配置失败（${where}）：${String(err)}`,
      { cause: err },
    );
  }
  if (!content) {
    throw new Error(`[config-loader] Nacos 配置为空（${where}）。`);
  }
  const parsed = load(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `[config-loader] Nacos 配置内容不是合法 YAML map（${where}）。`,
    );
  }
  return parsed as Record<string, unknown>;
}
