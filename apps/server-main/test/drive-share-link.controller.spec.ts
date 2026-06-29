/**
 * drive-share-link.controller.spec.ts
 *
 * 测试策略：薄单测（mock CloudShareLinkService），不依赖 DB / Postgres。
 * 覆盖：
 * 1. create — owner 创建返回 {token, url}，url 以 webMainBase+/share/ 开头
 * 2. create — service 抛错时向上传播
 * 3. list   — 返回含 url 的数组
 * 4. revoke — 调用 service.revoke 并返回 {ok:true}
 */
import "reflect-metadata";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { CloudShareLinkService } from "@meshbot/main";
import { DriveShareLinkController } from "../src/rest/drive-share-link.controller";
import { APP_CONFIG } from "../src/config/app-config.schema";
import type { AppConfig } from "../src/config/app-config.schema";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const WEB_MAIN_BASE = "http://localhost:3002";

const TEST_USER = {
  userId: "user-1",
  email: "owner@example.com",
  orgId: "org-1",
};

const MOCK_LINK = {
  id: "link-1",
  token: "abc12345",
  nodeId: "node-1",
  orgId: "org-1",
  createdByUserId: "user-1",
  passwordHash: null,
  expiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  revokedAt: null,
};

// ── FakeAuthGuard ─────────────────────────────────────────────────────────────

class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = TEST_USER;
    return true;
  }
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("DriveShareLinkController", () => {
  let app: INestApplication;
  let svc: jest.Mocked<
    Pick<CloudShareLinkService, "create" | "listForNode" | "revoke">
  >;

  const mockConfig: Partial<AppConfig> = {
    webMainBase: WEB_MAIN_BASE,
  };

  beforeEach(async () => {
    svc = {
      create: jest.fn(),
      listForNode: jest.fn(),
      revoke: jest.fn(),
    };

    const module = await Test.createTestingModule({
      controllers: [DriveShareLinkController],
      providers: [
        { provide: CloudShareLinkService, useValue: svc },
        { provide: APP_CONFIG, useValue: mockConfig },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── POST /drive/nodes/:id/share-links ─────────────────────────────────────

  describe("POST /drive/nodes/:id/share-links", () => {
    it("owner 创建 → 返回 {token, url}，url 以 webMainBase+/share/ 开头", async () => {
      svc.create.mockResolvedValue(MOCK_LINK as never);

      const res = await request(app.getHttpServer())
        .post("/drive/nodes/node-1/share-links")
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.token).toBe("abc12345");
      expect(res.body.url).toBe(`${WEB_MAIN_BASE}/share/abc12345`);
      expect(svc.create).toHaveBeenCalledWith(
        { userId: TEST_USER.userId },
        "node-1",
        expect.anything(),
      );
    });

    it("带 expiresInDays 时透传给 service", async () => {
      svc.create.mockResolvedValue(MOCK_LINK as never);

      await request(app.getHttpServer())
        .post("/drive/nodes/node-1/share-links")
        .send({ expiresInDays: 7 });

      expect(svc.create).toHaveBeenCalledWith(
        { userId: TEST_USER.userId },
        "node-1",
        expect.objectContaining({ expiresInDays: 7 }),
      );
    });

    it("service 抛错时向上传播（500）", async () => {
      svc.create.mockRejectedValue(new Error("unexpected"));

      const res = await request(app.getHttpServer())
        .post("/drive/nodes/node-1/share-links")
        .send({});

      expect(res.status).toBe(500);
    });
  });

  // ── GET /drive/nodes/:id/share-links ─────────────────────────────────────

  describe("GET /drive/nodes/:id/share-links", () => {
    it("返回含 url 的 ShareLinkView 数组", async () => {
      const linkWithPwd = { ...MOCK_LINK, passwordHash: "$bcrypt$hash" };
      svc.listForNode.mockResolvedValue([MOCK_LINK, linkWithPwd] as never);

      const res = await request(app.getHttpServer()).get(
        "/drive/nodes/node-1/share-links",
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);

      const first = res.body[0];
      expect(first.token).toBe("abc12345");
      expect(first.url).toBe(`${WEB_MAIN_BASE}/share/abc12345`);
      expect(first.requiresPassword).toBe(false);

      const second = res.body[1];
      expect(second.requiresPassword).toBe(true);
    });

    it("空数组时返回 []", async () => {
      svc.listForNode.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get(
        "/drive/nodes/node-1/share-links",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ── DELETE /drive/share-links/:linkId ─────────────────────────────────────

  describe("DELETE /drive/share-links/:linkId", () => {
    it("撤销成功 → 返回 {ok:true}", async () => {
      svc.revoke.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer()).delete(
        "/drive/share-links/link-1",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(svc.revoke).toHaveBeenCalledWith(
        { userId: TEST_USER.userId },
        "link-1",
      );
    });
  });
});
