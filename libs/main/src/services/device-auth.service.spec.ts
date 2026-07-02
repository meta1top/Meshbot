import { createHash, randomBytes } from "node:crypto";
import { injectLockProvider, MemoryLockProvider } from "@meshbot/common";
import type { DeviceAuthRequest } from "../entities/device-auth-request.entity";
import { DeviceAuthService } from "./device-auth.service";

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("hex");

function makeRepo(rows: DeviceAuthRequest[]) {
  return {
    create: jest.fn(
      (v: Partial<DeviceAuthRequest>) =>
        ({ attempts: 0, ...v }) as DeviceAuthRequest,
    ),
    save: jest.fn(async (v: DeviceAuthRequest) => {
      v.id ??= `r${rows.length + 1}`;
      rows.push(v);
      return v;
    }),
    findOne: jest.fn(
      async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
    ),
    update: jest.fn(
      async (cond: { id: string }, patch: Partial<DeviceAuthRequest>) => {
        for (const r of rows) if (r.id === cond.id) Object.assign(r, patch);
      },
    ),
  };
}

/** 构造 service：纯 new + 注入进程内锁 provider（@WithLock 依赖，见 conversation.service.spec 先例） */
function buildSvc(repo: ReturnType<typeof makeRepo>) {
  const svc = new DeviceAuthService(repo as never);
  injectLockProvider(svc, new MemoryLockProvider());
  return svc;
}

async function startApproved(rows: DeviceAuthRequest[], repo = makeRepo(rows)) {
  const svc = buildSvc(repo);
  const req = await svc.start({
    deviceName: "Mac",
    platform: "darwin",
    codeChallenge: challenge,
    redirectUri: "http://127.0.0.1:7727/api/auth/callback",
  });
  const { userCode } = await svc.approve(req.id, "u1");
  return { svc, req, userCode };
}

describe("DeviceAuthService", () => {
  it("start→approve→exchange 全流程返回批准人", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req, userCode } = await startApproved(rows);
    const result = await svc.exchange({
      requestId: req.id,
      userCode,
      codeVerifier: verifier,
    });
    expect(result.userId).toBe("u1");
    expect(rows[0].status).toBe("consumed");
  });

  it("exchange 二次兑换抛 invalid(consumed 不可重复)", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req, userCode } = await startApproved(rows);
    await svc.exchange({ requestId: req.id, userCode, codeVerifier: verifier });
    await expect(
      svc.exchange({ requestId: req.id, userCode, codeVerifier: verifier }),
    ).rejects.toMatchObject({ name: "AppError" });
  });

  it("verifier 不匹配立即作废整个请求", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req, userCode } = await startApproved(rows);
    await expect(
      svc.exchange({
        requestId: req.id,
        userCode,
        codeVerifier: "wrong-verifier",
      }),
    ).rejects.toBeTruthy();
    expect(rows[0].status).toBe("consumed");
  });

  it("userCode 错误累计 5 次后作废", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req } = await startApproved(rows);
    for (let i = 0; i < 5; i++) {
      await expect(
        svc.exchange({
          requestId: req.id,
          userCode: "bad",
          codeVerifier: verifier,
        }),
      ).rejects.toBeTruthy();
    }
    expect(rows[0].status).toBe("consumed");
  });

  it("过期请求 getForAuthorize 抛 DEVICE_AUTH_EXPIRED", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req } = await startApproved(rows);
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.getForAuthorize(req.id)).rejects.toMatchObject({
      name: "AppError",
    });
  });

  it("并发兑换同一请求只有一个成功(锁串行化,不铸双 token)", async () => {
    const rows: DeviceAuthRequest[] = [];
    const repo = makeRepo(rows);
    // 模拟真实 DB 写延迟：读到状态与写入状态之间存在窗口，暴露并发竞态
    const baseUpdate = repo.update.getMockImplementation();
    repo.update.mockImplementation(async (cond, patch) => {
      await new Promise((resolve) => setImmediate(resolve));
      return baseUpdate?.(cond, patch);
    });
    const { svc, req, userCode } = await startApproved(rows, repo);
    const results = await Promise.allSettled([
      svc.exchange({ requestId: req.id, userCode, codeVerifier: verifier }),
      svc.exchange({ requestId: req.id, userCode, codeVerifier: verifier }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(rows[0].status).toBe("consumed");
  });

  it("approve 非 pending 请求(已 approved)抛 DEVICE_AUTH_REQUEST_INVALID", async () => {
    const rows: DeviceAuthRequest[] = [];
    const { svc, req } = await startApproved(rows);
    await expect(svc.approve(req.id, "u2")).rejects.toMatchObject({
      name: "AppError",
    });
    expect(rows[0].userId).toBe("u1");
  });
});
