import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { SECURITY_CONFIG } from "../tokens";

export interface SecurityConfig {
  encryptionKey: string;
}

/** 对称加密工具:AES-256-GCM,密文 `iv.tag.data` 三段 base64url */
@Injectable()
export class SecretCryptoService {
  private readonly key: Buffer;

  constructor(@Optional() @Inject(SECURITY_CONFIG) config?: SecurityConfig) {
    const raw = config?.encryptionKey ?? "";
    if (raw.length < 32) throw new Error("security.encryptionKey 至少 32 字符");
    this.key = createHash("sha256").update(raw).digest();
  }

  /** 加密明文,返回可入库字符串 */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${data.toString("base64url")}`;
  }

  /** 解密入库密文;篡改/密钥不符抛错 */
  decrypt(sealed: string): string {
    const [iv, tag, data] = sealed
      .split(".")
      .map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  }
}
