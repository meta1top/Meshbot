import { EventEmitter } from "node:events";
import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS } from "@meshbot/types";
import type { ImReadInput, ImSendInput } from "@meshbot/types";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { ImRelayClientService } from "./im-relay-client.service";

/** 伪 socket：实现 on/emit/disconnect/connected，内置 EventEmitter。 */
class FakeSocket extends EventEmitter {
  public emitted: Array<[string, unknown]> = [];
  public disconnected = false;
  public connected = false;

  emit(event: string, ...args: unknown[]): boolean {
    this.emitted.push([event, args[0]]);
    return super.emit(event, ...args);
  }

  /** 模拟服务端推送事件（不记录到 emitted）。 */
  simulateServerEvent(event: string, payload: unknown): void {
    super.emit(event, payload);
  }

  disconnect(): void {
    this.disconnected = true;
    this.connected = false;
  }
}

/** 单账号镜像（仅取连接相关字段）。 */
type IdentityRow = { cloudToken: string; orgId: string | null } | null;

/**
 * 构造被测服务的辅助函数（账号化）。
 *
 * @param rows cloudUserId → 该账号身份镜像（null 表示未登录）。
 * @param sockets cloudUserId → 建连时返回的 FakeSocket（按账号区分）。
 */
function makeService(
  rows: Record<string, IdentityRow>,
  sockets: Record<string, FakeSocket>,
) {
  const cloudIdentityService = {
    get: jest.fn(async (cloudUserId: string) => rows[cloudUserId] ?? null),
    setLoggedOut: jest.fn().mockResolvedValue(undefined),
  };

  const emitter = new EventEmitter2();
  const emitSpy = jest.spyOn(emitter, "emit");

  // ioFactory 按建连请求的 auth.token 找回对应账号的 FakeSocket。
  const ioFactory = jest.fn(
    (_url: string, opts: { auth: { token: string } }): FakeSocket => {
      const cloudUserId = Object.keys(rows).find(
        (id) => rows[id]?.cloudToken === opts.auth.token,
      );
      const socket = sockets[cloudUserId ?? ""];
      socket.connected = true;
      return socket;
    },
  );

  const svc = new ImRelayClientService(
    cloudIdentityService as never,
    emitter,
    "http://cloud.test",
    new AccountContextService(),
    ioFactory as never,
  );

  return { svc, cloudIdentityService, emitter, emitSpy, ioFactory };
}

describe("ImRelayClientService", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("connect()（账号化）", () => {
    it("有 token + orgId → 用该账号 auth token 创建 socket", async () => {
      const s1 = new FakeSocket();
      const { svc, ioFactory } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );

      await svc.connect("u1");

      expect(ioFactory).toHaveBeenCalledTimes(1);
      const [url, opts] = ioFactory.mock.calls[0] as [
        string,
        { auth: { token: string } },
      ];
      expect(url).toBe("http://cloud.test/ws/im");
      expect(opts.auth.token).toBe("tok-u1");
      expect(svc.isConnected("u1")).toBe(true);

      svc.disconnect("u1");
    });

    it("两个账号 → 各自独立连接，互不影响", async () => {
      const s1 = new FakeSocket();
      const s2 = new FakeSocket();
      const { svc, ioFactory } = makeService(
        {
          u1: { cloudToken: "tok-u1", orgId: "org1" },
          u2: { cloudToken: "tok-u2", orgId: "org2" },
        },
        { u1: s1, u2: s2 },
      );

      await svc.connect("u1");
      await svc.connect("u2");

      expect(ioFactory).toHaveBeenCalledTimes(2);
      expect(svc.isConnected("u1")).toBe(true);
      expect(svc.isConnected("u2")).toBe(true);
      // u1 用 u1 的 token，u2 用 u2 的 token
      expect(
        (ioFactory.mock.calls[0][1] as { auth: { token: string } }).auth.token,
      ).toBe("tok-u1");
      expect(
        (ioFactory.mock.calls[1][1] as { auth: { token: string } }).auth.token,
      ).toBe("tok-u2");

      svc.disconnect("u1");
      svc.disconnect("u2");
    });

    it("无 cloudToken（未登录）→ 不创建 socket", async () => {
      const { svc, ioFactory } = makeService({ u1: null }, {});

      await svc.connect("u1");

      expect(ioFactory).not.toHaveBeenCalled();
      expect(svc.isConnected("u1")).toBe(false);
    });

    it("有 cloudToken 但 orgId 为 null → 不创建 socket", async () => {
      const { svc, ioFactory } = makeService(
        { u1: { cloudToken: "tok", orgId: null } },
        {},
      );

      await svc.connect("u1");

      expect(ioFactory).not.toHaveBeenCalled();
      expect(svc.isConnected("u1")).toBe(false);
    });

    it("idempotent：同账号重复 connect → 只创建一个 socket", async () => {
      const s1 = new FakeSocket();
      const { svc, ioFactory } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );

      await svc.connect("u1");
      await svc.connect("u1");

      expect(ioFactory).toHaveBeenCalledTimes(1);

      svc.disconnect("u1");
    });

    it("并发 connect 同账号两次 → 只创建一个 socket", async () => {
      const s1 = new FakeSocket();
      const cloudIdentityService = {
        // get 延迟一个宏任务以暴露竞态
        get: jest.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ cloudToken: "tok-u1", orgId: "org1" }),
                0,
              ),
            ),
        ),
        setLoggedOut: jest.fn(),
      };
      let creations = 0;
      const ioFactory = jest.fn((_url: string, _opts: unknown): FakeSocket => {
        creations++;
        s1.connected = true;
        return s1;
      });
      const svc = new ImRelayClientService(
        cloudIdentityService as never,
        new EventEmitter2(),
        "http://cloud.test",
        new AccountContextService(),
        ioFactory as never,
      );

      await Promise.all([svc.connect("u1"), svc.connect("u1")]);

      expect(creations).toBe(1);

      svc.disconnect("u1");
    });

    it("inbound message/presence/conversationCreated → emitter.emit 被调用", async () => {
      const s1 = new FakeSocket();
      const { svc, emitSpy } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );

      await svc.connect("u1");

      const msg = { id: "msg1", content: "hello" };
      s1.simulateServerEvent(IM_WS_EVENTS.message, msg);
      expect(emitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.message, msg);

      const presence = { userId: "u1", status: "online" };
      s1.simulateServerEvent(IM_WS_EVENTS.presence, presence);
      expect(emitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.presence, presence);

      const conv = { id: "conv1", name: "test" };
      s1.simulateServerEvent(IM_WS_EVENTS.conversationCreated, conv);
      expect(emitSpy).toHaveBeenCalledWith(
        IM_WS_EVENTS.conversationCreated,
        conv,
      );

      svc.disconnect("u1");
    });

    it("auth connect_error（unauthorized）→ disconnect + setLoggedOut(该账号)", async () => {
      const s1 = new FakeSocket();
      const { svc, cloudIdentityService } = makeService(
        { u1: { cloudToken: "stale", orgId: "org1" } },
        { u1: s1 },
      );

      await svc.connect("u1");
      expect(svc.isConnected("u1")).toBe(true);

      s1.simulateServerEvent("connect_error", new Error("unauthorized"));

      expect(svc.isConnected("u1")).toBe(false);
      expect(s1.disconnected).toBe(true);
      expect(cloudIdentityService.setLoggedOut).toHaveBeenCalledTimes(1);
      expect(cloudIdentityService.setLoggedOut).toHaveBeenCalledWith("u1");
    });

    it("auth connect_error 只影响出错账号，不动其他账号", async () => {
      const s1 = new FakeSocket();
      const s2 = new FakeSocket();
      const { svc, cloudIdentityService } = makeService(
        {
          u1: { cloudToken: "stale", orgId: "org1" },
          u2: { cloudToken: "tok-u2", orgId: "org2" },
        },
        { u1: s1, u2: s2 },
      );

      await svc.connect("u1");
      await svc.connect("u2");

      s1.simulateServerEvent("connect_error", new Error("unauthorized"));

      expect(svc.isConnected("u1")).toBe(false);
      expect(svc.isConnected("u2")).toBe(true);
      expect(cloudIdentityService.setLoggedOut).toHaveBeenCalledWith("u1");
      expect(cloudIdentityService.setLoggedOut).not.toHaveBeenCalledWith("u2");

      svc.disconnect("u2");
    });

    it("非 auth connect_error → 不调用 setLoggedOut", async () => {
      const s1 = new FakeSocket();
      const { svc, cloudIdentityService } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );

      await svc.connect("u1");
      s1.simulateServerEvent("connect_error", new Error("ECONNREFUSED"));

      expect(cloudIdentityService.setLoggedOut).not.toHaveBeenCalled();
      expect(svc.isConnected("u1")).toBe(true);

      svc.disconnect("u1");
    });
  });

  describe("disconnect()", () => {
    it("只断开指定账号，保留其他账号连接", async () => {
      const s1 = new FakeSocket();
      const s2 = new FakeSocket();
      const { svc } = makeService(
        {
          u1: { cloudToken: "tok-u1", orgId: "org1" },
          u2: { cloudToken: "tok-u2", orgId: "org2" },
        },
        { u1: s1, u2: s2 },
      );

      await svc.connect("u1");
      await svc.connect("u2");

      svc.disconnect("u1");

      expect(svc.isConnected("u1")).toBe(false);
      expect(s1.disconnected).toBe(true);
      expect(svc.isConnected("u2")).toBe(true);
      expect(s2.disconnected).toBe(false);

      svc.disconnect("u2");
    });

    it("idempotent：未连接账号 disconnect 不抛", () => {
      const { svc } = makeService({}, {});
      expect(() => svc.disconnect("nope")).not.toThrow();
    });
  });

  describe("send()", () => {
    it("connected → 用该账号 socket.emit(IM_WS_EVENTS.send, input)", async () => {
      const s1 = new FakeSocket();
      const { svc } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );
      await svc.connect("u1");

      const input: ImSendInput = { conversationId: "c1", content: "hi" };
      svc.send("u1", input);

      const sendEmit = s1.emitted.find(([ev]) => ev === IM_WS_EVENTS.send);
      expect(sendEmit).toBeDefined();
      expect(sendEmit?.[1]).toEqual(input);

      svc.disconnect("u1");
    });

    it("send 路由到正确账号的 socket", async () => {
      const s1 = new FakeSocket();
      const s2 = new FakeSocket();
      const { svc } = makeService(
        {
          u1: { cloudToken: "tok-u1", orgId: "org1" },
          u2: { cloudToken: "tok-u2", orgId: "org2" },
        },
        { u1: s1, u2: s2 },
      );
      await svc.connect("u1");
      await svc.connect("u2");

      const input: ImSendInput = { conversationId: "c1", content: "hi" };
      svc.send("u2", input);

      expect(s2.emitted.find(([ev]) => ev === IM_WS_EVENTS.send)).toBeDefined();
      expect(
        s1.emitted.find(([ev]) => ev === IM_WS_EVENTS.send),
      ).toBeUndefined();

      svc.disconnect("u1");
      svc.disconnect("u2");
    });

    it("not connected → 抛出 IM_NOT_CONNECTED AppError", async () => {
      const { svc } = makeService({ u1: null }, {});
      await svc.connect("u1");

      const input: ImSendInput = { conversationId: "c1", content: "hi" };
      expect(() => svc.send("u1", input)).toThrow(
        expect.objectContaining({ errorCode: AgentErrorCode.IM_NOT_CONNECTED }),
      );
    });
  });

  describe("read()", () => {
    it("connected → 该账号 socket.emit(IM_WS_EVENTS.read, input)", async () => {
      const s1 = new FakeSocket();
      const { svc } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );
      await svc.connect("u1");

      const input: ImReadInput = { conversationId: "c1" };
      svc.read("u1", input);

      const readEmit = s1.emitted.find(([ev]) => ev === IM_WS_EVENTS.read);
      expect(readEmit).toBeDefined();
      expect(readEmit?.[1]).toEqual(input);

      svc.disconnect("u1");
    });

    it("not connected → read() 静默返回（best-effort）", async () => {
      const { svc } = makeService({ u1: null }, {});
      await svc.connect("u1");

      const input: ImReadInput = { conversationId: "c1" };
      expect(() => svc.read("u1", input)).not.toThrow();
    });
  });

  describe("isConnected()", () => {
    it("connect 后返回 true，disconnect 后返回 false", async () => {
      const s1 = new FakeSocket();
      const { svc } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );
      await svc.connect("u1");
      expect(svc.isConnected("u1")).toBe(true);
      svc.disconnect("u1");
      expect(svc.isConnected("u1")).toBe(false);
    });

    it("未 connect → false", async () => {
      const { svc } = makeService({ u1: null }, {});
      await svc.connect("u1");
      expect(svc.isConnected("u1")).toBe(false);
    });
  });

  describe("onModuleDestroy()", () => {
    it("断开所有账号连接", async () => {
      const s1 = new FakeSocket();
      const s2 = new FakeSocket();
      const { svc } = makeService(
        {
          u1: { cloudToken: "tok-u1", orgId: "org1" },
          u2: { cloudToken: "tok-u2", orgId: "org2" },
        },
        { u1: s1, u2: s2 },
      );
      await svc.connect("u1");
      await svc.connect("u2");

      svc.onModuleDestroy();

      expect(svc.isConnected("u1")).toBe(false);
      expect(svc.isConnected("u2")).toBe(false);
      expect(s1.disconnected).toBe(true);
      expect(s2.disconnected).toBe(true);
    });

    it("无连接时安全 no-op", () => {
      const { svc } = makeService({}, {});
      expect(() => svc.onModuleDestroy()).not.toThrow();
    });
  });

  describe("getOnlinePeers()（在线快照缓存）", () => {
    it("下行 im.presence 维护缓存：online 入、offline 出", async () => {
      const s1 = new FakeSocket();
      const { svc } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );
      await svc.connect("u1");

      s1.simulateServerEvent(IM_WS_EVENTS.presence, {
        userId: "peerA",
        online: true,
      });
      s1.simulateServerEvent(IM_WS_EVENTS.presence, {
        userId: "peerB",
        online: true,
      });
      expect(svc.getOnlinePeers("u1").sort()).toEqual(["peerA", "peerB"]);

      s1.simulateServerEvent(IM_WS_EVENTS.presence, {
        userId: "peerA",
        online: false,
      });
      expect(svc.getOnlinePeers("u1")).toEqual(["peerB"]);

      svc.disconnect("u1");
    });

    it("disconnect 清空该账号缓存", async () => {
      const s1 = new FakeSocket();
      const { svc } = makeService(
        { u1: { cloudToken: "tok-u1", orgId: "org1" } },
        { u1: s1 },
      );
      await svc.connect("u1");
      s1.simulateServerEvent(IM_WS_EVENTS.presence, {
        userId: "peerA",
        online: true,
      });
      expect(svc.getOnlinePeers("u1")).toEqual(["peerA"]);

      svc.disconnect("u1");
      expect(svc.getOnlinePeers("u1")).toEqual([]);
    });

    it("未知账号 → 空数组", () => {
      const { svc } = makeService({}, {});
      expect(svc.getOnlinePeers("nope")).toEqual([]);
    });
  });
});
