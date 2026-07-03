import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import type { CaptureEmailSender } from "./capture-email-sender";

/**
 * e2e 共享助手：`POST /auth/register`（发验证码）→ 从 `CaptureEmailSender`
 * 取捕获的验证码 → `POST /auth/verify-email` 换 token。
 *
 * 取代 Task 5 遗留的“直接调 `UserService.markEmailVerified`”过渡 hack —— 现在
 * verify-email 是真实 REST 端点，e2e 走真端点流。
 */
export async function registerAndVerify(
  app: INestApplication,
  captureSender: CaptureEmailSender,
  email: string,
  password = "password1",
  displayName?: string,
): Promise<string> {
  const registerRes = await request(app.getHttpServer())
    .post("/api/auth/register")
    .send({
      email,
      password,
      displayName: displayName ?? email.split("@")[0],
    });
  if (registerRes.status !== 201) {
    throw new Error(
      `registerAndVerify: register 失败 status=${registerRes.status} body=${JSON.stringify(registerRes.body)}`,
    );
  }

  const captured = captureSender.lastVerification;
  if (!captured || captured.to !== email) {
    throw new Error(`registerAndVerify: 未捕获到 ${email} 的验证码`);
  }

  const verifyRes = await request(app.getHttpServer())
    .post("/api/auth/verify-email")
    .send({ email, code: captured.code });
  if (verifyRes.status !== 200 || !verifyRes.body?.data?.token) {
    throw new Error(
      `registerAndVerify: verify-email 失败 status=${verifyRes.status} body=${JSON.stringify(verifyRes.body)}`,
    );
  }
  return verifyRes.body.data.token as string;
}
