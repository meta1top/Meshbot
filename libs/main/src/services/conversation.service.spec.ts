import { AppError } from "@meshbot/common";
import { injectLockProvider } from "@meshbot/common";
import type { ConversationSummary } from "@meshbot/types";
import { Repository } from "typeorm";
import { MainErrorCode } from "../errors/main.error-codes";
import type { MembershipService } from "./membership.service";
import type { MessageService } from "./message.service";
import type { UserService } from "./user.service";
import { ConversationService } from "./conversation.service";

/**
 * ConversationService 单测。
 *
 * 测试策略：用最小手写桩替代 TypeORM Repository、MessageService、UserService。
 *
 * @Transactional() 装饰器通过 `findDataSource` 查找 service 上第一个
 * `instanceof Repository` 的字段来拿 DataSource。单测中需要让 convRepo/memberRepo
 * 通过该检查；做法：用 `Object.create(Repository.prototype)` 创建原型链正确的桩，
 * 并挂一个伪 DataSource（manager.connection）——其 createQueryRunner() 返回
 * passthrough QueryRunner，使 @Transactional 的 run/commit/release 路径
 * 不会抛错。
 *
 * @WithLock 需要 LockProvider；注入 passthrough provider（acquire → noop release）。
 */

const passthroughLock = {
  acquire: async () => async () => {},
};

/** 构造一个 passthrough QueryRunner（不真正开事务）。 */
function makeQueryRunner() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

/** 返回一个伪 DataSource（足够让 @Transactional 的 root 路径运行）。 */
function makeFakeDataSource() {
  return {
    createQueryRunner: () => makeQueryRunner(),
  };
}

// ────────────────────────────────────────────────────────────────────
// 工厂帮助函数
// ────────────────────────────────────────────────────────────────────

function makeConv(
  overrides: Partial<{
    id: string;
    orgId: string;
    type: string;
    name: string | null;
    dmKey: string | null;
    createdBy: string;
    createdAt: Date;
    visibility: "public" | "private";
  }> = {},
) {
  return {
    id: "conv-1",
    orgId: "org-1",
    type: "channel",
    name: "综合",
    dmKey: null,
    createdBy: "user-1",
    createdAt: new Date(),
    visibility: "public" as "public" | "private",
    ...overrides,
  };
}

function makeMember(
  overrides: Partial<{
    id: string;
    conversationId: string;
    userId: string;
    lastReadAt: Date | null;
    joinedAt: Date;
  }> = {},
) {
  return {
    id: "mem-1",
    conversationId: "conv-1",
    userId: "user-1",
    lastReadAt: null,
    joinedAt: new Date(),
    ...overrides,
  };
}

function makeUser(
  overrides: Partial<{
    id: string;
    displayName: string;
    email: string;
  }> = {},
) {
  return {
    id: "user-2",
    displayName: "Bob",
    email: "bob@example.com",
    passwordHash: "x",
    activeOrgId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * 构造带充分桩方法的 convRepo。
 *
 * 关键：用 Object.create(Repository.prototype) 让桩通过
 * @Transactional 装饰器的 `instanceof Repository` 检查，
 * 并挂 manager.connection（伪 DataSource）供装饰器拿 queryRunner。
 */
function makeConvRepo(overrides: Record<string, jest.Mock> = {}) {
  const memberSaveStub = jest
    .fn()
    .mockImplementation((e) =>
      Promise.resolve({ id: "mem-new", joinedAt: new Date(), ...e }),
    );
  const fakeDs = makeFakeDataSource();
  const repo = Object.assign(Object.create(Repository.prototype), {
    create: jest.fn().mockImplementation((data: object) => ({ ...data })),
    save: jest
      .fn()
      .mockImplementation((e: object) =>
        Promise.resolve({ id: "conv-new", createdAt: new Date(), ...e }),
      ),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    upsert: jest.fn().mockResolvedValue(undefined),
    manager: {
      connection: fakeDs,
      getRepository: jest.fn().mockReturnValue({
        create: jest.fn().mockImplementation((data: object) => ({ ...data })),
        save: memberSaveStub,
        findOne: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(undefined),
        count: jest.fn().mockResolvedValue(0),
      }),
    },
    ...overrides,
  });
  return repo as typeof repo;
}

/**
 * 构造带充分桩方法的 memberRepo。
 * 同样需要通过 instanceof Repository（用于 findDataSource 备用路径）。
 */
function makeMemberRepo(overrides: Record<string, jest.Mock> = {}) {
  const repo = Object.assign(Object.create(Repository.prototype), {
    create: jest.fn().mockImplementation((data: object) => ({ ...data })),
    save: jest
      .fn()
      .mockImplementation((e: object) =>
        Promise.resolve({ id: "mem-new", joinedAt: new Date(), ...e }),
      ),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(0),
    ...overrides,
  });
  return repo as typeof repo;
}

function makeMessageSvc(
  overrides: Partial<Record<keyof MessageService, jest.Mock>> = {},
): MessageService {
  return {
    unreadCount: jest.fn().mockResolvedValue(0),
    lastMessage: jest.fn().mockResolvedValue(null),
    persistMessage: jest.fn(),
    listMessages: jest.fn(),
    ...overrides,
  } as unknown as MessageService;
}

function makeUserSvc(
  overrides: Partial<Record<keyof UserService, jest.Mock>> = {},
): UserService {
  return {
    findById: jest.fn().mockResolvedValue(null),
    registerUser: jest.fn(),
    loginUser: jest.fn(),
    ...overrides,
  } as unknown as UserService;
}

function makeMembershipSvc(
  overrides: Partial<Record<keyof MembershipService, jest.Mock>> = {},
): MembershipService {
  return {
    isMember: jest.fn().mockResolvedValue(true),
    assertMember: jest.fn().mockResolvedValue(undefined),
    listOrgsForUser: jest.fn().mockResolvedValue([]),
    listMembers: jest.fn().mockResolvedValue([]),
    roleOf: jest.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as MembershipService;
}

/** 构造 ConversationService，注入 passthrough lock。 */
function buildSvc(
  convRepo: ReturnType<typeof makeConvRepo>,
  memberRepo: ReturnType<typeof makeMemberRepo>,
  messageSvc: MessageService,
  userSvc: UserService,
  membershipSvc: MembershipService = makeMembershipSvc(),
) {
  const svc = new ConversationService(
    convRepo as never,
    memberRepo as never,
    messageSvc,
    userSvc,
    membershipSvc,
  );
  injectLockProvider(svc, passthroughLock as never);
  return svc;
}

// ════════════════════════════════════════════════════════════════════
// 测试套件
// ════════════════════════════════════════════════════════════════════

describe("ConversationService", () => {
  // ── persistChannelInTx ────────────────────────────────────────────
  describe("persistChannelInTx", () => {
    it("建频道：返回 type=channel，name 与参数一致", async () => {
      const conv = makeConv({ id: "conv-ch", type: "channel", name: "公告" });
      const convRepo = makeConvRepo({
        save: jest.fn().mockResolvedValue(conv),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      const out: ConversationSummary = await svc.persistChannelInTx(
        "org-1",
        "公告",
        "user-1",
      );
      expect(out.type).toBe("channel");
      expect(out.name).toBe("公告");
      expect(out.peer).toBeNull();
    });

    it("persistChannelInTx 返回的 id 来自保存后的 conversation", async () => {
      const conv = makeConv({
        id: "ch-id-123",
        type: "channel",
        name: "General",
      });
      const convRepo = makeConvRepo({
        save: jest.fn().mockResolvedValue(conv),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      const out = await svc.persistChannelInTx("org-1", "General", "user-1");
      expect(out.id).toBe("ch-id-123");
    });
  });

  // ── findOrCreateDm ────────────────────────────────────────────────
  describe("findOrCreateDm", () => {
    it("第一次调用：建新 DM 会话，返回 type=dm", async () => {
      const dmConv = makeConv({
        id: "dm-1",
        type: "dm",
        name: null,
        dmKey: "user-a:user-b",
      });
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(dmConv),
      });
      const bob = makeUser({
        id: "user-b",
        displayName: "Bob",
        email: "bob@x.io",
      });
      const userSvc = makeUserSvc({
        findById: jest.fn().mockResolvedValue(bob),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        userSvc,
      );
      const out = await svc.findOrCreateDm("org-1", "user-a", "user-b");
      expect(out.type).toBe("dm");
      expect(out.id).toBe("dm-1");
    });

    it("二次调用（同两人）→ 不重复创建，返回同一 conversation id", async () => {
      const dmConv = makeConv({
        id: "dm-existing",
        type: "dm",
        name: null,
        dmKey: "user-a:user-b",
      });
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(dmConv),
        save: jest.fn(),
      });
      const bob = makeUser({ id: "user-b" });
      const memberRepo = makeMemberRepo({
        findOne: jest
          .fn()
          .mockResolvedValue(
            makeMember({ userId: "user-a", conversationId: "dm-existing" }),
          ),
      });
      const userSvc = makeUserSvc({
        findById: jest.fn().mockResolvedValue(bob),
      });
      const svc = buildSvc(convRepo, memberRepo, makeMessageSvc(), userSvc);
      const out = await svc.findOrCreateDm("org-1", "user-a", "user-b");
      expect(out.id).toBe("dm-existing");
      expect(convRepo.save).not.toHaveBeenCalled();
    });

    it("(a,b) 和 (b,a) 用同一 dmKey（排序不变）", async () => {
      const findOne = jest.fn().mockResolvedValue(null);
      const savedConv = makeConv({
        id: "dm-new",
        type: "dm",
        name: null,
        dmKey: "user-a:user-b",
      });
      const convRepo = makeConvRepo({
        findOne,
        save: jest.fn().mockResolvedValue(savedConv),
      });
      const bob = makeUser({ id: "user-b" });
      const userSvc = makeUserSvc({
        findById: jest.fn().mockResolvedValue(bob),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        userSvc,
      );

      await svc.findOrCreateDm("org-1", "user-a", "user-b");
      await svc.findOrCreateDm("org-1", "user-b", "user-a");

      const calls = findOne.mock.calls;
      expect(calls).toHaveLength(2);
      const dmKey0 = (calls[0][0] as { where: { dmKey: string } }).where.dmKey;
      const dmKey1 = (calls[1][0] as { where: { dmKey: string } }).where.dmKey;
      expect(dmKey0).toBe(dmKey1);
      expect(dmKey0).toBe("user-a:user-b");
    });

    it("(b,a) 反序调用 → 结果与正序调用的 id/dmKey 相同（锁键排序不变性）", async () => {
      // 两次调用都返回同一个已存在的 conversation（模拟加锁后 find 命中）
      const dmConv = makeConv({
        id: "dm-sort-inv",
        type: "dm",
        name: null,
        dmKey: "user-a:user-b",
      });
      const findOne = jest.fn().mockResolvedValue(dmConv);
      const convRepo = makeConvRepo({ findOne, save: jest.fn() });
      const userSvc = makeUserSvc({
        findById: jest
          .fn()
          .mockResolvedValue(
            makeUser({ id: "user-b", displayName: "Bob", email: "b@x.io" }),
          ),
      });

      // 测试 acquireLock 记录的 key — 替换 passthroughLock，捕获 key 参数
      const lockKeys: string[] = [];
      const capturingLock = {
        acquire: async (key: string) => {
          lockKeys.push(key);
          return async () => {};
        },
      };

      const svc = new ConversationService(
        convRepo as never,
        makeMemberRepo() as never,
        makeMessageSvc(),
        userSvc,
        makeMembershipSvc() as never,
      );
      // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
      (injectLockProvider as (svc: any, p: any) => void)(svc, capturingLock);

      const outAB = await svc.findOrCreateDm("org-1", "user-a", "user-b");
      const outBA = await svc.findOrCreateDm("org-1", "user-b", "user-a");

      // 两次结果指向同一 conversation
      expect(outAB.id).toBe("dm-sort-inv");
      expect(outBA.id).toBe("dm-sort-inv");

      // 两次加锁都使用排好序的 dmKey（user-a:user-b）
      expect(lockKeys).toHaveLength(2);
      expect(lockKeys[0]).toContain("user-a:user-b");
      expect(lockKeys[1]).toContain("user-a:user-b");
      // 两次 key 完全相同（排序不变性）
      expect(lockKeys[0]).toBe(lockKeys[1]);
    });

    it("返回的 peer 是对端用户（a 发起 → peer.userId = b）", async () => {
      const dmConv = makeConv({
        id: "dm-p",
        type: "dm",
        name: null,
        dmKey: "alice:bob",
      });
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(dmConv),
      });
      const bob = makeUser({
        id: "bob",
        displayName: "Bob Smith",
        email: "bob@acme.io",
      });
      const userSvc = makeUserSvc({
        findById: jest.fn().mockResolvedValue(bob),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        userSvc,
      );

      const out = await svc.findOrCreateDm("org-1", "alice", "bob");
      expect(out.peer).not.toBeNull();
      expect(out.peer?.userId).toBe("bob");
      expect(out.peer?.displayName).toBe("Bob Smith");
      expect(out.peer?.email).toBe("bob@acme.io");
      expect(userSvc.findById).toHaveBeenCalledWith("bob");
    });
  });

  // ── getVisibleOrThrow ─────────────────────────────────────────────
  describe("getVisibleOrThrow", () => {
    it("channel：orgId 匹配时返回 conversation", async () => {
      const conv = makeConv({ id: "ch-v", orgId: "org-1", type: "channel" });
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(conv),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      const result = await svc.getVisibleOrThrow("ch-v", "user-1", "org-1");
      expect(result.id).toBe("ch-v");
    });

    it("channel：orgId 不匹配时抛 AppError", async () => {
      const conv = makeConv({
        id: "ch-v",
        orgId: "org-other",
        type: "channel",
      });
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(conv),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      await expect(
        svc.getVisibleOrThrow("ch-v", "user-1", "org-1"),
      ).rejects.toBeInstanceOf(AppError);
    });

    it("dm：用户有 member 行时返回 conversation", async () => {
      const conv = makeConv({
        id: "dm-v",
        orgId: "org-1",
        type: "dm",
        name: null,
      });
      const member = makeMember({ conversationId: "dm-v", userId: "user-1" });
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(conv),
      });
      const memberRepo = makeMemberRepo({
        findOne: jest.fn().mockResolvedValue(member),
      });
      const svc = buildSvc(
        convRepo,
        memberRepo,
        makeMessageSvc(),
        makeUserSvc(),
      );
      const result = await svc.getVisibleOrThrow("dm-v", "user-1", "org-1");
      expect(result.id).toBe("dm-v");
    });

    it("dm：用户无 member 行时抛 CONVERSATION_FORBIDDEN", async () => {
      const conv = makeConv({
        id: "dm-v",
        orgId: "org-1",
        type: "dm",
        name: null,
      });
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(conv),
      });
      const memberRepo = makeMemberRepo({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const svc = buildSvc(
        convRepo,
        memberRepo,
        makeMessageSvc(),
        makeUserSvc(),
      );
      await expect(
        svc.getVisibleOrThrow("dm-v", "user-1", "org-1"),
      ).rejects.toMatchObject({
        errorCode: MainErrorCode.CONVERSATION_FORBIDDEN,
      });
    });

    it("conversation 不存在时抛 CONVERSATION_NOT_FOUND", async () => {
      const convRepo = makeConvRepo({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      await expect(
        svc.getVisibleOrThrow("no-such", "user-1", "org-1"),
      ).rejects.toMatchObject({
        errorCode: MainErrorCode.CONVERSATION_NOT_FOUND,
      });
    });
  });

  // ── ensureDefaultChannel ──────────────────────────────────────
  describe("ensureDefaultChannel", () => {
    it("空 org → 建「综合」频道", async () => {
      const convRepo = makeConvRepo({
        count: jest.fn().mockResolvedValue(0),
        save: jest.fn().mockResolvedValue(makeConv({ name: "综合" })),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      await svc.ensureDefaultChannel("org-1", "user-1");
      expect(convRepo.save).toHaveBeenCalledTimes(1);
      const savedConv = convRepo.save.mock.calls[0][0] as { name: string };
      expect(savedConv.name).toBe("综合");
    });

    it("已有频道 → 不重复建（幂等）", async () => {
      const convRepo = makeConvRepo({
        count: jest.fn().mockResolvedValue(1),
        save: jest.fn(),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      await svc.ensureDefaultChannel("org-1", "user-1");
      expect(convRepo.save).not.toHaveBeenCalled();
    });

    it("二次调用（count 从 0 变 1）→ 第一次建，第二次不建", async () => {
      let channelCount = 0;
      const convRepo = makeConvRepo({
        count: jest
          .fn()
          .mockImplementation(() => Promise.resolve(channelCount)),
        save: jest.fn().mockImplementation(() => {
          channelCount = 1;
          return Promise.resolve(makeConv({ name: "综合" }));
        }),
      });
      const svc = buildSvc(
        convRepo,
        makeMemberRepo(),
        makeMessageSvc(),
        makeUserSvc(),
      );
      await svc.ensureDefaultChannel("org-1", "user-1");
      await svc.ensureDefaultChannel("org-1", "user-1");
      expect(convRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  // ── listConversations ─────────────────────────────────────────────
  describe("listConversations", () => {
    it("空 org → ensureDefaultChannel 后返回含「综合」频道", async () => {
      const channelConv = makeConv({
        id: "ch-default",
        name: "综合",
        type: "channel",
      });
      const member = makeMember({
        conversationId: "ch-default",
        userId: "user-1",
      });
      let channelCount = 0;
      const convRepo = makeConvRepo({
        count: jest
          .fn()
          .mockImplementation(() => Promise.resolve(channelCount)),
        find: jest.fn().mockResolvedValue([channelConv]),
        save: jest.fn().mockImplementation(() => {
          channelCount = 1;
          return Promise.resolve(channelConv);
        }),
      });
      const memberRepo = makeMemberRepo({
        find: jest.fn().mockResolvedValue([member]),
        findOne: jest.fn().mockResolvedValue(member),
      });
      const msgSvc = makeMessageSvc({
        unreadCount: jest.fn().mockResolvedValue(3),
        lastMessage: jest.fn().mockResolvedValue(null),
      });
      const svc = buildSvc(convRepo, memberRepo, msgSvc, makeUserSvc());
      const list = await svc.listConversations("user-1", "org-1");
      expect(list.length).toBeGreaterThanOrEqual(1);
      const ch = list.find((c) => c.name === "综合");
      expect(ch).toBeDefined();
      expect(ch?.type).toBe("channel");
    });

    it("unreadCount 由 MessageService.unreadCount 提供（stub 验证）", async () => {
      const channelConv = makeConv({
        id: "ch-1",
        name: "公告",
        type: "channel",
      });
      const member = makeMember({
        conversationId: "ch-1",
        userId: "user-1",
        lastReadAt: new Date(),
      });
      const convRepo = makeConvRepo({
        count: jest.fn().mockResolvedValue(1),
        find: jest.fn().mockResolvedValue([channelConv]),
      });
      const memberRepo = makeMemberRepo({
        find: jest.fn().mockResolvedValue([member]),
        findOne: jest.fn().mockResolvedValue(member),
      });
      const msgSvc = makeMessageSvc({
        unreadCount: jest.fn().mockResolvedValue(5),
        lastMessage: jest.fn().mockResolvedValue(null),
      });
      const svc = buildSvc(convRepo, memberRepo, msgSvc, makeUserSvc());
      const list = await svc.listConversations("user-1", "org-1");
      expect(list[0].unreadCount).toBe(5);
      expect(msgSvc.unreadCount).toHaveBeenCalled();
    });
  });

  // ── markRead ──────────────────────────────────────────────────────
  describe("markRead", () => {
    it("upsert conversation_member.lastReadAt", async () => {
      const memberRepo = makeMemberRepo({
        upsert: jest.fn().mockResolvedValue(undefined),
      });
      const svc = buildSvc(
        makeConvRepo(),
        memberRepo,
        makeMessageSvc(),
        makeUserSvc(),
      );
      await svc.markRead("conv-1", "user-1");
      expect(memberRepo.upsert).toHaveBeenCalledTimes(1);
    });
  });

  // ── 私有频道 ──────────────────────────────────────────────────────
  describe("私有频道", () => {
    // ── listConversations 可见性 ────────────────────────────────────
    describe("listConversations", () => {
      it("公开频道对非成员可见", async () => {
        const publicCh = makeConv({
          id: "ch-pub",
          type: "channel",
          visibility: "public",
          name: "公开",
        });
        // convRepo.find 第一次（公开频道）返回 publicCh；后续调用返回空
        const findMock = jest
          .fn()
          .mockResolvedValueOnce([publicCh]) // public channels
          .mockResolvedValue([]); // candidates (no private convs)
        const convRepo = makeConvRepo({
          count: jest.fn().mockResolvedValue(1),
          find: findMock,
        });
        // 非成员：memberRepo.find({where:{userId}}) 返回空（无任何会话成员行）
        const memberRepo = makeMemberRepo({
          find: jest.fn().mockResolvedValue([]),
          findOne: jest.fn().mockResolvedValue(null),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
        );
        const list = await svc.listConversations("non-member", "org-1");
        expect(list.some((c) => c.id === "ch-pub")).toBe(true);
      });

      it("私有频道只对成员可见，非成员看不到", async () => {
        const privateCh = makeConv({
          id: "ch-priv",
          type: "channel",
          visibility: "private",
          name: "私密",
        });
        const publicCh = makeConv({
          id: "ch-pub",
          type: "channel",
          visibility: "public",
          name: "公开",
        });
        // 成员：在私有频道有 member 行
        const memberRow = makeMember({
          conversationId: "ch-priv",
          userId: "user-member",
        });

        // 非成员的 convRepo.find 调用
        const findMockNonMember = jest
          .fn()
          .mockResolvedValueOnce([publicCh]) // public channels
          .mockResolvedValue([publicCh, privateCh]); // candidates (org channels)
        const convRepoNonMember = makeConvRepo({
          count: jest.fn().mockResolvedValue(2),
          find: findMockNonMember,
        });
        // 非成员无 member 行
        const memberRepoNonMember = makeMemberRepo({
          find: jest.fn().mockResolvedValue([]),
          findOne: jest.fn().mockResolvedValue(null),
        });
        const svcNonMember = buildSvc(
          convRepoNonMember,
          memberRepoNonMember,
          makeMessageSvc(),
          makeUserSvc(),
        );
        const listNonMember = await svcNonMember.listConversations(
          "non-member",
          "org-1",
        );
        expect(listNonMember.some((c) => c.id === "ch-priv")).toBe(false);
        expect(listNonMember.some((c) => c.id === "ch-pub")).toBe(true);

        // 成员能看到私有频道
        const findMockMember = jest
          .fn()
          .mockResolvedValueOnce([publicCh]) // public channels
          .mockResolvedValue([publicCh, privateCh]); // candidates (all org convs)
        const convRepoMember = makeConvRepo({
          count: jest.fn().mockResolvedValue(2),
          find: findMockMember,
        });
        const memberRepoMember = makeMemberRepo({
          // find({where:{userId}}) → 有 ch-priv 的 member 行
          find: jest.fn().mockResolvedValue([memberRow]),
          findOne: jest.fn().mockResolvedValue(memberRow),
        });
        const svcMember = buildSvc(
          convRepoMember,
          memberRepoMember,
          makeMessageSvc(),
          makeUserSvc(),
        );
        const listMember = await svcMember.listConversations(
          "user-member",
          "org-1",
        );
        expect(listMember.some((c) => c.id === "ch-priv")).toBe(true);
      });
    });

    // ── getVisibleOrThrow 私有频道 ──────────────────────────────────
    describe("getVisibleOrThrow 私有频道", () => {
      it("私有频道：非成员抛 CONVERSATION_FORBIDDEN", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(null),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
        );
        await expect(
          svc.getVisibleOrThrow("ch-priv", "non-member", "org-1"),
        ).rejects.toMatchObject({
          errorCode: MainErrorCode.CONVERSATION_FORBIDDEN,
        });
      });

      it("私有频道：成员可以访问", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const member = makeMember({
          conversationId: "ch-priv",
          userId: "user-1",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(member),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
        );
        const result = await svc.getVisibleOrThrow(
          "ch-priv",
          "user-1",
          "org-1",
        );
        expect(result.id).toBe("ch-priv");
      });
    });

    // ── addMember ───────────────────────────────────────────────────
    describe("addMember", () => {
      it("actor 非频道成员 → CONVERSATION_FORBIDDEN", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        // actor 在频道无 member 行
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(null),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
        );
        await expect(
          svc.addMember("ch-priv", "actor-not-member", "target"),
        ).rejects.toMatchObject({
          errorCode: MainErrorCode.CONVERSATION_FORBIDDEN,
        });
      });

      it("target 非组织成员 → CHANNEL_MEMBER_INVALID", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const actorMember = makeMember({
          conversationId: "ch-priv",
          userId: "actor",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(actorMember),
        });
        // target 不是 org 成员
        const membershipSvc = makeMembershipSvc({
          isMember: jest.fn().mockResolvedValue(false),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
          membershipSvc,
        );
        await expect(
          svc.addMember("ch-priv", "actor", "non-org-user"),
        ).rejects.toMatchObject({
          errorCode: MainErrorCode.CHANNEL_MEMBER_INVALID,
        });
      });

      it("happy path：成功添加成员，调用 upsert", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const actorMember = makeMember({
          conversationId: "ch-priv",
          userId: "actor",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const upsert = jest.fn().mockResolvedValue(undefined);
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(actorMember),
          upsert,
        });
        const membershipSvc = makeMembershipSvc({
          isMember: jest.fn().mockResolvedValue(true),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
          membershipSvc,
        );
        const result = await svc.addMember("ch-priv", "actor", "new-member");
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(result.orgId).toBe("org-1");
      });

      it("幂等：重复 addMember 不抛错，再次调用 upsert", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const actorMember = makeMember({
          conversationId: "ch-priv",
          userId: "actor",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const upsert = jest.fn().mockResolvedValue(undefined);
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(actorMember),
          upsert,
        });
        const membershipSvc = makeMembershipSvc({
          isMember: jest.fn().mockResolvedValue(true),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
          membershipSvc,
        );
        await svc.addMember("ch-priv", "actor", "new-member");
        await svc.addMember("ch-priv", "actor", "new-member");
        expect(upsert).toHaveBeenCalledTimes(2);
      });
    });

    // ── leave ───────────────────────────────────────────────────────
    describe("leave", () => {
      it("成员退出：调用 delete，返回 orgId", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const member = makeMember({
          conversationId: "ch-priv",
          userId: "user-1",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const deleteFn = jest.fn().mockResolvedValue(undefined);
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(member),
          delete: deleteFn,
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
        );
        const result = await svc.leave("ch-priv", "user-1");
        expect(deleteFn).toHaveBeenCalledTimes(1);
        expect(result.orgId).toBe("org-1");
      });

      it("非成员调用 leave → CONVERSATION_FORBIDDEN", async () => {
        const conv = makeConv({
          id: "ch-priv",
          orgId: "org-1",
          type: "channel",
          visibility: "private",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const memberRepo = makeMemberRepo({
          findOne: jest.fn().mockResolvedValue(null),
        });
        const svc = buildSvc(
          convRepo,
          memberRepo,
          makeMessageSvc(),
          makeUserSvc(),
        );
        await expect(svc.leave("ch-priv", "non-member")).rejects.toMatchObject({
          errorCode: MainErrorCode.CONVERSATION_FORBIDDEN,
        });
      });

      it("公开频道调用 leave → CONVERSATION_FORBIDDEN", async () => {
        const conv = makeConv({
          id: "ch-pub",
          orgId: "org-1",
          type: "channel",
          visibility: "public",
        });
        const convRepo = makeConvRepo({
          findOne: jest.fn().mockResolvedValue(conv),
        });
        const svc = buildSvc(
          convRepo,
          makeMemberRepo(),
          makeMessageSvc(),
          makeUserSvc(),
        );
        await expect(svc.leave("ch-pub", "user-1")).rejects.toMatchObject({
          errorCode: MainErrorCode.CONVERSATION_FORBIDDEN,
        });
      });
    });
  });
});
