import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudIdentityService } from "./cloud-identity.service";

/**
 * 网盘 gateway：纯 JSON 转发，将 server-agent 的网盘请求代理至
 * server-main `/api/drive/*`，使用当前账号的 deviceToken 鉴权。
 * presigned putUrl/url 等字段原样透传，不做二次处理。
 */
@Injectable()
export class DriveGatewayService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  /** 取当前账号 deviceToken；无则抛 AUTH_UNAUTHORIZED。 */
  private async token(): Promise<string> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.deviceToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return id.deviceToken;
  }

  /** 列出节点（目录内容）；parentId=null 表示根目录。 */
  async listNodes(parentId: string | null): Promise<unknown> {
    const q = parentId ? `?parentId=${encodeURIComponent(parentId)}` : "";
    return this.cloud.get(`/api/drive/nodes${q}`, await this.token());
  }

  /** 列出他人共享给我的节点。 */
  async listShared(): Promise<unknown> {
    return this.cloud.get("/api/drive/shared", await this.token());
  }

  /** 获取配额信息。 */
  async getQuota(): Promise<unknown> {
    return this.cloud.get("/api/drive/quota", await this.token());
  }

  /** 创建文件夹。 */
  async createFolder(body: unknown): Promise<unknown> {
    return this.cloud.post("/api/drive/folders", body, await this.token());
  }

  /** 申请上传（返回含 presigned putUrl 的响应，原样透传）。 */
  async requestUpload(body: unknown): Promise<unknown> {
    return this.cloud.post("/api/drive/uploads", body, await this.token());
  }

  /** 确认上传完成。 */
  async completeUpload(nodeId: string, body: unknown): Promise<unknown> {
    return this.cloud.post(
      `/api/drive/uploads/${encodeURIComponent(nodeId)}/complete`,
      body,
      await this.token(),
    );
  }

  /** 获取文件下载 URL（presigned，原样透传）。 */
  async getFileUrl(id: string): Promise<unknown> {
    return this.cloud.get(
      `/api/drive/files/${encodeURIComponent(id)}/url`,
      await this.token(),
    );
  }

  /** 更新节点元数据（重命名、移动等）。 */
  async updateNode(id: string, body: unknown): Promise<unknown> {
    return this.cloud.patch(
      `/api/drive/nodes/${encodeURIComponent(id)}`,
      body,
      await this.token(),
    );
  }

  /** 删除节点（含子树）。 */
  async deleteNode(id: string): Promise<unknown> {
    return this.cloud.del(
      `/api/drive/nodes/${encodeURIComponent(id)}`,
      await this.token(),
    );
  }

  /** 获取节点权限列表。 */
  async getGrants(id: string): Promise<unknown> {
    return this.cloud.get(
      `/api/drive/nodes/${encodeURIComponent(id)}/grants`,
      await this.token(),
    );
  }

  /** 设置节点权限（完整覆盖）。 */
  async setGrants(id: string, body: unknown): Promise<unknown> {
    return this.cloud.put(
      `/api/drive/nodes/${encodeURIComponent(id)}/grants`,
      body,
      await this.token(),
    );
  }

  /** 创建节点公开分享链接（需 deviceToken）。 */
  async createShareLink(nodeId: string, body: unknown): Promise<unknown> {
    return this.cloud.post(
      `/api/drive/nodes/${encodeURIComponent(nodeId)}/share-links`,
      body,
      await this.token(),
    );
  }

  /** 匿名：解析分享 token（无需 deviceToken）。 */
  async resolveShare(token: string): Promise<unknown> {
    return this.cloud.get(`/api/share/${encodeURIComponent(token)}`);
  }

  /** 匿名：申请下载分享文件（无需 deviceToken）。 */
  async downloadShare(token: string, body: unknown): Promise<unknown> {
    return this.cloud.post(
      `/api/share/${encodeURIComponent(token)}/download`,
      body,
    );
  }
}
