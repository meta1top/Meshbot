import { randomInt } from "node:crypto";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { EmailVerification } from "../entities/email-verification.entity";
import { MainErrorCode } from "../errors/main.error-codes";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

/** 注册邮箱验证码：签发（带冷却）与校验（带尝试上限） */
@Injectable()
export class EmailVerificationService {
  constructor(
    @InjectRepository(EmailVerification)
    private readonly verifyRepo: Repository<EmailVerification>,
  ) {}

  /** 签发 6 位验证码；60 秒冷却内重复签发抛错 */
  async issueCode(email: string): Promise<string> {
    const latest = await this.latest(email);
    if (
      latest &&
      Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      throw new AppError(MainErrorCode.AUTH_VERIFICATION_COOLDOWN);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.verifyRepo.save(
      this.verifyRepo.create({
        email,
        code,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        createdAt: new Date(),
      }),
    );
    return code;
  }

  /** 校验验证码；通过后删除该邮箱全部记录 */
  async verifyCode(email: string, code: string): Promise<void> {
    const latest = await this.latest(email);
    const expired = !latest || latest.expiresAt.getTime() < Date.now();
    if (expired || latest.attempts >= MAX_ATTEMPTS)
      throw new AppError(MainErrorCode.AUTH_VERIFICATION_INVALID);
    if (latest.code !== code) {
      await this.verifyRepo.update(
        { id: latest.id },
        { attempts: latest.attempts + 1 },
      );
      throw new AppError(MainErrorCode.AUTH_VERIFICATION_INVALID);
    }
    await this.verifyRepo.delete({ email });
  }

  private latest(email: string): Promise<EmailVerification | null> {
    return this.verifyRepo.findOne({
      where: { email },
      order: { createdAt: "DESC" },
    });
  }
}
