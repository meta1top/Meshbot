import { createHash, randomBytes } from "node:crypto";
import { AppError, WithLock } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { DeviceAuthRequest } from "../entities/device-auth-request.entity";
import { MainErrorCode } from "../errors/main.error-codes";

const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_EXCHANGE_ATTEMPTS = 5;

/**
 * 设备授权请求状态机：pending → approved → consumed。
 *
 * 本地 Agent 通过授权码进行设备级登录验证。
 */
@Injectable()
export class DeviceAuthService {
  constructor(
    @InjectRepository(DeviceAuthRequest)
    private readonly requestRepo: Repository<DeviceAuthRequest>,
  ) {}

  /**
   * 本地 Agent 发起授权请求（公开端点调用，无身份）。
   *
   * 返回新建的授权请求，状态为 pending，10 分钟过期。
   */
  async start(input: {
    deviceName: string;
    platform: string;
    codeChallenge: string;
    redirectUri: string | null;
  }): Promise<DeviceAuthRequest> {
    return this.requestRepo.save(
      this.requestRepo.create({
        ...input,
        status: "pending",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      }),
    );
  }

  /**
   * 授权确认页读取请求信息（已登录用户）。
   *
   * 如请求不存在或已过期，抛出 DEVICE_AUTH_REQUEST_INVALID 或 DEVICE_AUTH_EXPIRED。
   */
  async getForAuthorize(requestId: string) {
    const req = await this.findValid(requestId);
    return {
      id: req.id,
      deviceName: req.deviceName,
      platform: req.platform,
      status: req.status,
    };
  }

  /**
   * 用户批准授权：生成一次性 userCode。
   *
   * 非 pending 状态抛出 DEVICE_AUTH_REQUEST_INVALID。
   * 按 requestId 加锁：防并发批准互相覆盖 userCode。
   */
  @WithLock({ key: "device-auth:approve:#{0}", waitTimeout: 5000 })
  async approve(
    requestId: string,
    userId: string,
  ): Promise<{ userCode: string; redirectUri: string | null }> {
    const req = await this.findValid(requestId);
    if (req.status !== "pending")
      throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    const userCode = randomBytes(9).toString("base64url");
    await this.requestRepo.update(
      { id: req.id },
      { status: "approved", userId, userCode },
    );
    return { userCode, redirectUri: req.redirectUri };
  }

  /**
   * 本地 Agent 兑换：校验 userCode + code_verifier，成功置 consumed 并返回批准人 +
   * 原始设备信息（`start` 时提交的 deviceName/platform，随请求存储，兑换后直接带出，
   * 免去调用方二次 `getForAuthorize` 查询 —— 避免 consumed 状态下二次查询的边界处理）。
   *
   * 验证流程：
   * 1. 检查请求不过期且状态为 approved
   * 2. 校验 code_verifier（SHA256）与存储的 challenge 匹配
   *    - 不匹配立即作废请求（防提权尝试）
   * 3. 校验 userCode
   *    - 不匹配累计失败次数，达 5 次后作废
   * 4. 校验通过置 consumed，返回批准人 + 设备信息
   *
   * 按 requestId 加锁：防同一请求并发兑换双双通过 approved 检查铸出两个
   * device token（"consumed 不可重复兑换"不变量）。
   *
   * tx-check: ignore — 三处 update 分属互斥分支(verifier 不匹配/userCode 错误/成功兑换)，每次执行只有一处单表写。
   */
  @WithLock({ key: "device-auth:exchange:#{0.requestId}", waitTimeout: 5000 })
  async exchange(input: {
    requestId: string;
    userCode: string;
    codeVerifier: string;
  }): Promise<{ userId: string; deviceName: string; platform: string }> {
    const req = await this.findValid(input.requestId);
    if (req.status !== "approved" || !req.userId || !req.userCode) {
      throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    }
    const challenge = createHash("sha256")
      .update(input.codeVerifier)
      .digest("hex");
    if (challenge !== req.codeChallenge) {
      await this.requestRepo.update({ id: req.id }, { status: "consumed" });
      throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    }
    if (input.userCode !== req.userCode) {
      const attempts = req.attempts + 1;
      const patch: Partial<DeviceAuthRequest> = { attempts };
      if (attempts >= MAX_EXCHANGE_ATTEMPTS) patch.status = "consumed";
      await this.requestRepo.update({ id: req.id }, patch);
      throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    }
    await this.requestRepo.update({ id: req.id }, { status: "consumed" });
    return {
      userId: req.userId,
      deviceName: req.deviceName,
      platform: req.platform,
    };
  }

  /**
   * 校验请求存在且未过期。
   *
   * 不存在抛 DEVICE_AUTH_REQUEST_INVALID，过期抛 DEVICE_AUTH_EXPIRED。
   */
  private async findValid(requestId: string): Promise<DeviceAuthRequest> {
    const req = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!req) throw new AppError(MainErrorCode.DEVICE_AUTH_REQUEST_INVALID);
    if (req.expiresAt.getTime() < Date.now())
      throw new AppError(MainErrorCode.DEVICE_AUTH_EXPIRED);
    return req;
  }
}
