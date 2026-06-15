import { EventEmitter } from "node:events";
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
    setLoggedOut: jest.fn().mockResolvedValue(undefined),
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

  // Task 3.6: connect() 当前中性化为 no-op（CloudIdentity 多行后旧单行连接已失效）。
  // 以下依赖 connect() 实际建立 socket 的用例整组跳过，待 3.6 重建按账号 connect(cloudUserId) 后恢复。
  describe.skip("connect()（Task 3.6 重建）", () => {
    it("有 token + orgId → 用 auth token 创建 socket", async () => {
      const socket = new FakeSocket();
      const ioSpy = jest.fn(makeIoFactory(socket));
      const cloudIdentityService = {
        get: jest
          .fn()
          .mockResolvedValue({ cloudToken: "tok123", orgId: "org1" }),
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
  });

  describe("send()", () => {
    // Task 3.6: connected 分支依赖 connect() 建立 socket，待 3.6 重建。
    it.skip("connected → socket.emit(IM_WS_EVENTS.send, input) 被调用", () => {});

    it("not connected → 抛出 IM_NOT_CONNECTED AppError", async () => {
      const socket = new FakeSocket();
      // connect() 中性化 no-op → socket 始终 null → send 抛错
      const { svc } = makeService(null, null, socket);
      await svc.connect();

      const input: ImSendInput = { conversationId: "c1", content: "hi" };
      expect(() => svc.send(input)).toThrow(
        expect.objectContaining({ errorCode: AgentErrorCode.IM_NOT_CONNECTED }),
      );
    });
  });

  describe("read()", () => {
    // Task 3.6: connected 分支依赖 connect() 建立 socket，待 3.6 重建。
    it.skip("connected → socket.emit(IM_WS_EVENTS.read, input)", () => {});

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
    // Task 3.6: connect 后为 true 依赖建立 socket，待 3.6 重建。
    it.skip("connect 后返回 true", () => {});
    it.skip("disconnect 后返回 false", () => {});

    it("未 connect → false", async () => {
      const socket = new FakeSocket();
      const { svc } = makeService(null, null, socket);
      await svc.connect(); // no-op
      expect(svc.isConnected()).toBe(false);
    });
  });

  describe("onModuleDestroy()", () => {
    it("无 socket 时安全 no-op（disconnect 不抛）", () => {
      const socket = new FakeSocket();
      const { svc } = makeService(null, null, socket);
      expect(() => svc.onModuleDestroy()).not.toThrow();
      expect(svc.isConnected()).toBe(false);
    });

    // Task 3.6: 销毁时断开已建立的 socket，依赖 connect() 建立 socket，待 3.6 重建。
    it.skip("模块销毁时断开 socket 并清理定时器", () => {});
  });
});
