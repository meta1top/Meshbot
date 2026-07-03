import { Injectable } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";

interface CloudMetaData {
  webMainBase: string;
}

/**
 * 云端元信息代理：透传 server-main 的 `GET /api/meta`（webMainBase 等），
 * 供前端拼跳转链接（登录页「注册账号」、设置页组织后台等）。
 *
 * `webMainBase` 是部署期静态配置，不随运行时变化 —— 成功拿到一次后进程内
 * 内存缓存，不再重复请求云端；请求失败（云端不可达等）不缓存，下次调用照常重试。
 */
@Injectable()
export class CloudMetaService {
  private cached: CloudMetaData | null = null;

  constructor(private readonly cloud: CloudClientService) {}

  /** 取 web-main 前端基础 URL；命中缓存直接返回，否则代理云端并缓存成功结果。 */
  async getWebMainBase(): Promise<string> {
    if (!this.cached) {
      this.cached = await this.cloud.get<CloudMetaData>("/api/meta");
    }
    return this.cached.webMainBase;
  }
}
