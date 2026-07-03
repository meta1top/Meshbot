import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { Device } from "../entities/device.entity";
import { MainErrorCode } from "../errors/main.error-codes";

export const DEVICE_TOKEN_PREFIX = "mbd_";
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/** 计算 device token 的入库哈希 */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 设备(device token)归属 Service:签发、校验、吊销、切组织 */
@Injectable()
export class DeviceService {
  constructor(
    @InjectRepository(Device) private readonly deviceRepo: Repository<Device>,
  ) {}

  /** 签发新设备与 token;明文 token 仅此一次返回 */
  async issueDevice(input: {
    userId: string;
    orgId: string | null;
    name: string;
    platform: string;
  }): Promise<{ device: Device; token: string }> {
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const device = await this.deviceRepo.save(
      this.deviceRepo.create({
        ...input,
        tokenHash: hashDeviceToken(token),
        lastSeenAt: new Date(),
      }),
    );
    return { device, token };
  }

  /** 校验 token,返回设备;未知/已吊销抛 DEVICE_TOKEN_INVALID;低频回写 lastSeenAt */
  async verifyToken(token: string): Promise<Device> {
    const device = await this.deviceRepo.findOne({
      where: { tokenHash: hashDeviceToken(token) },
    });
    if (!device || device.revokedAt)
      throw new AppError(MainErrorCode.DEVICE_TOKEN_INVALID);
    const stale =
      !device.lastSeenAt ||
      Date.now() - device.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS;
    if (stale)
      await this.deviceRepo.update(
        { id: device.id },
        { lastSeenAt: new Date() },
      );
    return device;
  }

  /** 列出用户全部设备(含已吊销,前端区分展示) */
  async listByUser(userId: string): Promise<Device[]> {
    return this.deviceRepo.find({ where: { userId } });
  }

  /** 吊销本人设备;非本人抛 DEVICE_NOT_FOUND */
  async revoke(userId: string, deviceId: string): Promise<void> {
    const device = await this.deviceRepo.findOne({ where: { id: deviceId } });
    if (!device || device.userId !== userId)
      throw new AppError(MainErrorCode.DEVICE_NOT_FOUND);
    if (!device.revokedAt)
      await this.deviceRepo.update({ id: deviceId }, { revokedAt: new Date() });
  }

  /** 设备切换当前激活组织 */
  async updateOrg(deviceId: string, orgId: string): Promise<void> {
    await this.deviceRepo.update({ id: deviceId }, { orgId });
  }
}
