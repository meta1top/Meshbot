import { SecretCryptoService } from "./secret-crypto.service";

describe("SecretCryptoService", () => {
  const svc = new SecretCryptoService({
    encryptionKey: "0123456789abcdef0123456789abcdef",
  });

  it("加解密往返", () => {
    const sealed = svc.encrypt("sk-test-123");
    expect(sealed).not.toContain("sk-test-123");
    expect(svc.decrypt(sealed)).toBe("sk-test-123");
  });

  it("同明文两次加密产生不同密文(随机 IV)", () => {
    expect(svc.encrypt("a")).not.toBe(svc.encrypt("a"));
  });

  it("密文被篡改时抛错", () => {
    const sealed = svc.encrypt("secret");
    const parts = sealed.split(".");
    parts[2] = Buffer.from("tampered!!").toString("base64url");
    expect(() => svc.decrypt(parts.join("."))).toThrow();
  });

  it("密钥长度不足 32 字符时构造抛错", () => {
    expect(() => new SecretCryptoService({ encryptionKey: "short" })).toThrow();
  });
});
