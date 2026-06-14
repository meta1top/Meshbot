import { EventEmitter } from "node:events";
import { IM_WS_EVENTS } from "@meshbot/types";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { ImSendInput, ImReadInput } from "@meshbot/types";
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

/** 创建一个返回给定 FakeSocket 的 io 工厂。 */
function makeIoFactory(socket: FakeSocket) {
  return (_url: string, _opts: unknown): FakeSocket => {
    socket.connected = true;
    return socket;
  };
}

/** 构造被测服务的辅助函数。 */
function makeService(
  cloudToken: string | null,
  orgId: string | null,
  socket: FakeSocket,
) {
  const cloudIdentityService = {
    get: jest
      .fn()
      .mockResolvedValue(cloudToken !== null ? { cloudToken, orgId } : null),
    clear: jest.fn().mockResolvedValue(undefined),
  };

  const emitter = new EventEmitter2();
  const emitSpy = jest.spyOn(emitter, "emit");

  const ioFactory = makeIoFactory(socket);

  const svc = new ImRelayClientService(
    cloudIdentityService as never,
    emitter,
    "http://cloud.test",
    ioFactory as never,
  );

  return { svc, cloudIdentityService, emitter, emitSpy, socket };
}

describe("ImRelayClientService", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("connect()", () => {
    it("有 token + orgId → 用 auth token 创建 socket", async () => {
      const socket = new FakeSocket();
      const ioSpy = jest.fn(makeIoFactory(socket));
      const cloudIdentityService = {
        get: jest
          .fn()
          .mockResolvedValue({ cloudToken: "tok123", orgId: "org1" }),
        clear: jest.fn(),
      };
      const emitter = new EventEmitter2();
      const svc = new ImRelayClientService(
        cloudIdentityService as never,
        emitter,
        "http://cloud.test",
        ioSpy as never,
      );

      await svc.connect();

      expect(ioSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = ioSpy.mock.calls[0] as [
        string,
        { auth: { token: string } },
      ];
      expect(url).toBe("http://cloud.test/ws/im");
      expect(opts.auth.token).toBe("tok123");

      svc.disconnect();
    });

    it("无 cloudToken（未登录）→ 不创建 socket", async () => {
      const socket = new FakeSocket();
      const ioSpy = jest.fn(makeIoFactory(socket));
      const cloudIdentityService = {
        get: jest.fn().mockResolvedValue(null),
        clear: jest.fn(),
      };
      const emitter = new EventEmitter2();
      const svc = new ImRelayClientService(
        cloudIdentityService as never,
        emitter,
        "http://cloud.test",
        ioSpy as never,
      );

      await svc.connect();

      expect(ioSpy).not.toHaveBeenCalled();
      expect(svc.isConnected()).toBe(false);
    });

    it("有 cloudToken 但 orgId 为 null → 不创建 socket", async () => {
      const socket = new FakeSocket();
      const ioSpy = jest.fn(makeIoFactory(socket));
      const cloudIdentityService = {
        get: jest.fn().mockResolvedValue({ cloudToken: "tok", orgId: null }),
        clear: jest.fn(),
      };
      const emitter = new EventEmitter2();
      const svc = new ImRelayClientService(
        cloudIdentityService as never,
        emitter,
        "http://cloud.test",
        ioSpy as never,
      );

      await svc.connect();

      expect(ioSpy).not.toHaveBeenCalled();
      expect(svc.isConnected()).toBe(false);
    });

    it("inbound message 事件 → emitter.emit(IM_WS_EVENTS.message, payload) 被调用", async () => {
      const socket = new FakeSocket();
      const { svc, emitSpy } = makeService("tok", "org1", socket);

      await svc.connect();

      const payload = { id: "msg1", content: "hello" };
      socket.simulateServerEvent(IM_WS_EVENTS.message, payload);

      expect(emitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.message, payload);

      svc.disconnect();
    });

    it("inbound presence 事件 → emitter.emit(IM_WS_EVENTS.presence, payload)", async () => {
      const socket = new FakeSocket();
      const { svc, emitSpy } = makeService("tok", "org1", socket);

      await svc.connect();

      const payload = { userId: "u1", status: "online" };
      socket.simulateServerEvent(IM_WS_EVENTS.presence, payload);

      expect(emitSpy).toHaveBeenCalledWith(IM_WS_EVENTS.presence, payload);

      svc.disconnect();
    });

    it("inbound conversationCreated 事件 → emitter.emit(IM_WS_EVENTS.conversationCreated, payload)", async () => {
      const socket = new FakeSocket();
      const { svc, emitSpy } = makeService("tok", "org1", socket);

      await svc.connect();

      const payload = { id: "conv1", name: "test" };
      socket.simulateServerEvent(IM_WS_EVENTS.conversationCreated, payload);

      expect(emitSpy).toHaveBeenCalledWith(
        IM_WS_EVENTS.conversationCreated,
        payload,
      );

      svc.disconnect();
    });

    it("auth connect_error（含 unauthorized）→ 调用 cloudIdentityService.clear()", async () => {
      const socket = new FakeSocket();
      const cloudIdentityService = {
        get: jest
          .fn()
          .mockResolvedValue({ cloudToken: "stale", orgId: "org1" }),
        clear: jest.fn().mockResolvedValue(undefined),
      };
      const emitter = new EventEmitter2();
      const ioFactory = makeIoFactory(socket);
      const svc = new ImRelayClientService(
        cloudIdentityService as never,
        emitter,
        "http://cloud.test",
        ioFactory as never,
      );

      await svc.connect();

      // 模拟服务端认证失败的 connect_error
      const authErr = new Error("unauthorized");
      socket.simulateServerEvent("connect_error", authErr);

      expect(cloudIdentityService.clear).toHaveBeenCalledTimes(1);

      svc.disconnect();
    });

    it("非 auth connect_error → 不调用 cloudIdentityService.clear()", async () => {
      const socket = new FakeSocket();
      const cloudIdentityService = {
        get: jest.fn().mockResolvedValue({ cloudToken: "tok", orgId: "org1" }),
        clear: jest.fn().mockResolvedValue(undefined),
      };
      const emitter = new EventEmitter2();
      const ioFactory = makeIoFactory(socket);
      const svc = new ImRelayClientService(
        cloudIdentityService as never,
        emitter,
        "http://cloud.test",
        ioFactory as never,
      );

      await svc.connect();

      const netErr = new Error("ECONNREFUSED");
      socket.simulateServerEvent("connect_error", netErr);

      expect(cloudIdentityService.clear).not.toHaveBeenCalled();

      svc.disconnect();
    });
  });

  describe("send()", () => {
    it("connected → socket.emit(IM_WS_EVENTS.send, input) 被调用", async () => {
      const socket = new FakeSocket();
      const { svc } = makeService("tok", "org1", socket);
      await svc.connect();

      const input: ImSendInput = { conversationId: "c1", content: "hi" };
      svc.send(input);

      const sendEmit = socket.emitted.find(([ev]) => ev === IM_WS_EVENTS.send);
      expect(sendEmit).toBeDefined();
      expect(sendEmit?.[1]).toEqual(input);

      svc.disconnect();
    });

    it("not connected → 抛出 IM_NOT_CONNECTED AppError", async () => {
      const socket = new FakeSocket();
      // cloudToken = null → 不会连接
      const { svc } = makeService(null, null, socket);
      await svc.connect();

      const input: ImSendInput = { conversationId: "c1", content: "hi" };
      expect(() => svc.send(input)).toThrow(
        expect.objectContaining({ errorCode: AgentErrorCode.IM_NOT_CONNECTED }),
      );
    });
  });

  describe("read()", () => {
    it("connected → socket.emit(IM_WS_EVENTS.read, input)", async () => {
      const socket = new FakeSocket();
      const { svc } = makeService("tok", "org1", socket);
      await svc.connect();

      const input: ImReadInput = { conversationId: "c1" };
      svc.read(input);

      const readEmit = socket.emitted.find(([ev]) => ev === IM_WS_EVENTS.read);
      expect(readEmit).toBeDefined();
      expect(readEmit?.[1]).toEqual(input);

      svc.disconnect();
    });

    it("not connected → read() 静默返回（best-effort）", async () => {
      const socket = new FakeSocket();
      const { svc } = makeService(null, null, socket);
      await svc.connect();

      const input: ImReadInput = { conversationId: "c1" };
      // 不应抛出
      expect(() => svc.read(input)).not.toThrow();
    });
  });

  describe("isConnected()", () => {
    it("connect 后返回 true", async () => {
      const socket = new FakeSocket();
      const { svc } = makeService("tok", "org1", socket);
      await svc.connect();
      expect(svc.isConnected()).toBe(true);
      svc.disconnect();
    });

    it("disconnect 后返回 false", async () => {
      const socket = new FakeSocket();
      const { svc } = makeService("tok", "org1", socket);
      await svc.connect();
      svc.disconnect();
      expect(svc.isConnected()).toBe(false);
    });

    it("未 connect → false", async () => {
      const socket = new FakeSocket();
      const { svc } = makeService(null, null, socket);
      await svc.connect(); // no-op
      expect(svc.isConnected()).toBe(false);
    });
  });
});
