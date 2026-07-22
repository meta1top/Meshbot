import type { Socket } from "socket.io";

import { BaseWebSocketGateway } from "./base-gateway";

/** 具体子类：BaseWebSocketGateway 是抽象类，测试需要一个可实例化的实现。 */
class TestGateway extends BaseWebSocketGateway {
  protected jwtVerify(): unknown {
    return null;
  }
}

/**
 * 造一个够用的假 socket。`disconnect` 可通过 `alive:false` 摘掉，
 * 用于模拟「服务端已强制关闭连接、socket 被拆解」的状态。
 */
function makeSocket(opts: { user?: unknown; alive?: boolean } = {}) {
  const { user, alive = true } = opts;
  const listeners = new Map<string, () => void>();
  const socket = {
    data: user ? { user } : {},
    once(event: string, cb: () => void) {
      listeners.set(event, cb);
    },
    emit(event: string) {
      listeners.get(event)?.();
    },
  } as unknown as Socket & { emit(event: string): void };

  if (alive) {
    (socket as unknown as { disconnect: jest.Mock }).disconnect = jest.fn();
  }
  return socket;
}

describe("BaseWebSocketGateway 未鉴权宽限定时器", () => {
  let gateway: TestGateway;

  beforeEach(() => {
    jest.useFakeTimers();
    gateway = new TestGateway();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("未鉴权连接在宽限期到期后被断开", () => {
    const socket = makeSocket();
    gateway.handleConnection(socket);

    jest.advanceTimersByTime(10_000);

    expect(
      (socket as unknown as { disconnect: jest.Mock }).disconnect,
    ).toHaveBeenCalledWith(true);
  });

  it("已鉴权连接不启动定时器", () => {
    const socket = makeSocket({ user: { id: "u1" } });
    gateway.handleConnection(socket);

    jest.advanceTimersByTime(10_000);

    expect(
      (socket as unknown as { disconnect: jest.Mock }).disconnect,
    ).not.toHaveBeenCalled();
  });

  it("宽限期内完成鉴权则到期不再断开", () => {
    const socket = makeSocket();
    gateway.handleConnection(socket);
    (socket.data as { user?: unknown }).user = { id: "u1" };

    jest.advanceTimersByTime(10_000);

    expect(
      (socket as unknown as { disconnect: jest.Mock }).disconnect,
    ).not.toHaveBeenCalled();
  });

  it("disconnect 事件清掉定时器", () => {
    const socket = makeSocket();
    gateway.handleConnection(socket);
    (socket as unknown as { emit(e: string): void }).emit("disconnect");

    jest.advanceTimersByTime(10_000);

    expect(
      (socket as unknown as { disconnect: jest.Mock }).disconnect,
    ).not.toHaveBeenCalled();
  });

  /**
   * 回归用例——这是 CI 上 `client.disconnect is not a function` 的成因：
   * e2e 里 `app.close()` 强制关闭 socket.io server 时，socket 可能不派发
   * `disconnect` 事件就被拆解，定时器的唯一清理路径失效；10 秒后定时器仍触发，
   * 此时 client 已不是可用的 socket，直接调用即抛 TypeError。
   *
   * 该异常逃逸到 jest worker 后会被归咎于「当时正在跑的那个套件」，所以表现为
   * 失败套件在多次运行间漂移（实测 auth-profile.e2e → skill-flow）。
   */
  it("socket 已被拆解（disconnect 不再可调用）时到期不抛异常", () => {
    const socket = makeSocket({ alive: false });
    gateway.handleConnection(socket);

    expect(() => jest.advanceTimersByTime(10_000)).not.toThrow();
  });
});
