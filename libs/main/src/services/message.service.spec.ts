import type { ImMessage, MessagePage } from "@meshbot/types";
import { MoreThan, Not } from "typeorm";
import { MessageService } from "./message.service";

/**
 * MessageService 单测 — 用最小手写桩替代 Repository（镜像 invitation.service.spec.ts 风格）。
 * 覆盖：persistMessage / listMessages（游标分页）/ unreadCount / lastMessage。
 */
describe("MessageService", () => {
  const makeMsg = (
    overrides: Partial<{
      id: string;
      conversationId: string;
      senderId: string;
      content: string;
      createdAt: Date;
    }> = {},
  ) => ({
    id: "msg-1",
    conversationId: "conv-1",
    senderId: "user-1",
    content: "hello",
    createdAt: new Date("2024-01-01T10:00:00.000Z"),
    ...overrides,
  });

  // ─── persistMessage ────────────────────────────────────────────────────────

  describe("persistMessage", () => {
    it("保存消息并返回含 id 的 ImMessage（createdAt 为 ISO 字符串）", async () => {
      const saved = makeMsg();
      const repo = {
        create: jest
          .fn()
          .mockImplementation((d: object) => ({ ...saved, ...d })),
        save: jest.fn().mockImplementation((e: object) => Promise.resolve(e)),
        createQueryBuilder: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn(),
      };
      const svc = new MessageService(repo as never);
      const out: ImMessage = await svc.persistMessage(
        "conv-1",
        "user-1",
        "hello",
      );
      expect(out.id).toBeTruthy();
      expect(out.conversationId).toBe("conv-1");
      expect(out.senderId).toBe("user-1");
      expect(out.content).toBe("hello");
      expect(typeof out.createdAt).toBe("string");
      expect(() => new Date(out.createdAt)).not.toThrow();
      expect(repo.save).toHaveBeenCalledTimes(1);
    });
  });

  // ─── listMessages ──────────────────────────────────────────────────────────

  describe("listMessages", () => {
    const buildQueryBuilder = (rows: ReturnType<typeof makeMsg>[]) => {
      const qb: Record<string, jest.Mock> = {};
      const chain = () => qb as never;
      qb.where = jest.fn().mockReturnValue(chain());
      qb.andWhere = jest.fn().mockReturnValue(chain());
      qb.orderBy = jest.fn().mockReturnValue(chain());
      qb.take = jest.fn().mockReturnValue(chain());
      qb.getMany = jest.fn().mockResolvedValue(rows);
      return qb;
    };

    it("before=undefined → 取最新 limit 条（正序返回）, hasMore 正确（无更多）", async () => {
      // 3 条消息，limit=5 → hasMore=false
      const rows = [
        makeMsg({ id: "3", createdAt: new Date("2024-01-01T10:03:00Z") }),
        makeMsg({ id: "2", createdAt: new Date("2024-01-01T10:02:00Z") }),
        makeMsg({ id: "1", createdAt: new Date("2024-01-01T10:01:00Z") }),
      ];
      const qb = buildQueryBuilder(rows);
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        findOne: jest.fn(),
        count: jest.fn(),
      };
      const svc = new MessageService(repo as never);
      const out: MessagePage = await svc.listMessages("conv-1", undefined, 5);
      expect(out.hasMore).toBe(false);
      expect(out.messages).toHaveLength(3);
      // 返回正序（ASC by createdAt）
      expect(out.messages[0].id).toBe("1");
      expect(out.messages[2].id).toBe("3");
    });

    it("before=undefined, 取到 limit+1 条 → hasMore=true，返回仅 limit 条（正序）", async () => {
      // 查询返回 limit+1=6 条（DESC），hasMore=true
      const rows = Array.from({ length: 6 }, (_, i) =>
        makeMsg({
          id: String(6 - i),
          createdAt: new Date(`2024-01-01T10:0${6 - i}:00Z`),
        }),
      );
      const qb = buildQueryBuilder(rows);
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        findOne: jest.fn(),
        count: jest.fn(),
      };
      const svc = new MessageService(repo as never);
      const out: MessagePage = await svc.listMessages("conv-1", undefined, 5);
      expect(out.hasMore).toBe(true);
      expect(out.messages).toHaveLength(5);
      // 正序
      expect(Number(out.messages[0].id)).toBeLessThan(
        Number(out.messages[4].id),
      );
    });

    it("传 before=msgId → 先查该消息 createdAt 再游标分页", async () => {
      const cursorMsg = makeMsg({
        id: "cursor",
        createdAt: new Date("2024-01-01T10:05:00Z"),
      });
      const olderRows = [
        makeMsg({ id: "2", createdAt: new Date("2024-01-01T10:04:00Z") }),
        makeMsg({ id: "1", createdAt: new Date("2024-01-01T10:03:00Z") }),
      ];
      const qb = buildQueryBuilder(olderRows);
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        findOne: jest.fn().mockResolvedValue(cursorMsg),
        count: jest.fn(),
      };
      const svc = new MessageService(repo as never);
      const out: MessagePage = await svc.listMessages("conv-1", "cursor", 5);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: "cursor" },
        select: ["createdAt"],
      });
      expect(out.messages).toHaveLength(2);
      expect(out.hasMore).toBe(false);
    });
  });

  // ─── unreadCount ───────────────────────────────────────────────────────────

  describe("unreadCount", () => {
    it("lastReadAt=null → 返回全部消息数", async () => {
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn().mockResolvedValue(7),
      };
      const svc = new MessageService(repo as never);
      const n = await svc.unreadCount("conv-1", null);
      expect(n).toBe(7);
      expect(repo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ conversationId: "conv-1" }),
        }),
      );
    });

    it("lastReadAt=某时刻 → 只统计该时刻之后的消息", async () => {
      const ts = new Date("2024-01-01T10:00:00Z");
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      };
      const svc = new MessageService(repo as never);
      const n = await svc.unreadCount("conv-1", ts);
      expect(n).toBe(3);
      expect(repo.count).toHaveBeenCalledWith({
        where: { conversationId: "conv-1", createdAt: MoreThan(ts) },
      });
    });

    it("excludeSenderId → 排除自己发的消息（自己发的不计未读）", async () => {
      const ts = new Date("2024-01-01T10:00:00Z");
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
        findOne: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      };
      const svc = new MessageService(repo as never);
      const n = await svc.unreadCount("conv-1", ts, "user-self");
      expect(n).toBe(2);
      expect(repo.count).toHaveBeenCalledWith({
        where: {
          conversationId: "conv-1",
          createdAt: MoreThan(ts),
          senderId: Not("user-self"),
        },
      });
    });
  });

  // ─── lastMessage ──────────────────────────────────────────────────────────

  describe("lastMessage", () => {
    it("会话有消息 → 返回最新一条（ImMessage）", async () => {
      const msg = makeMsg({ id: "latest" });
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
        findOne: jest.fn().mockResolvedValue(msg),
        count: jest.fn(),
      };
      const svc = new MessageService(repo as never);
      const out = await svc.lastMessage("conv-1");
      expect(out).not.toBeNull();
      expect(out!.id).toBe("latest");
      expect(typeof out!.createdAt).toBe("string");
    });

    it("空会话 → 返回 null", async () => {
      const repo = {
        create: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(),
        findOne: jest.fn().mockResolvedValue(null),
        count: jest.fn(),
      };
      const svc = new MessageService(repo as never);
      const out = await svc.lastMessage("conv-1");
      expect(out).toBeNull();
    });
  });
});
