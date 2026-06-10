import "reflect-metadata";
import path from "node:path";
import {
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  traceIdMiddleware,
  WsExceptionFilter,
} from "@meshbot/common";
// WsExceptionFilter via APP_FILTER provider — see WsTestModule below
import { type INestApplication, Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  I18nService,
} from "nestjs-i18n";
import { io as createClient, type Socket } from "socket.io-client";

import { HealthGateway } from "../../src/ws/health.gateway";

const I18N_PATH = path.join(__dirname, "..", "..", "i18n");
const JWT_SECRET = "ws-e2e-secret";

/**
 * 等待 socket 收一条事件；超时 fail。
 */
function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event);
      reject(
        new Error(`[ws-e2e] event "${event}" timeout after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: "zh",
      loader: I18nJsonLoader,
      loaderOptions: { path: I18N_PATH },
      resolvers: [new HeaderResolver(["x-lang"]), new AcceptLanguageResolver()],
    }),
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: "1h" },
    }),
  ],
  providers: [
    HealthGateway,
    // 让 @UseFilters(WsExceptionFilter) 在 gateway 上能通过 DI 拿 I18nService
    WsExceptionFilter,
  ],
  exports: [JwtModule],
})
class WsTestModule {}

describe("HealthGateway e2e", () => {
  let app: INestApplication;
  let port: number;
  let validToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WsTestModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(traceIdMiddleware);
    const i18n = app.get(I18nService);
    const reflector = app.get(Reflector);
    app.useGlobalPipes(new I18nZodValidationPipe(i18n));
    app.useGlobalInterceptors(new ResponseInterceptor(reflector));
    app.useGlobalFilters(new ErrorsFilter(i18n));

    await app.listen(0); // 任意可用端口
    const server = app.getHttpServer();
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("无法解析 ws e2e 端口");
    }
    port = addr.port;

    const jwt = app.get(JwtService);
    validToken = jwt.sign({ sub: "user-1", email: "ws@test.io" });
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function connect(opts: { token?: string; traceId?: string }): Socket {
    return createClient(`http://localhost:${port}/ws/health`, {
      auth: {
        ...(opts.token ? { token: opts.token } : {}),
        ...(opts.traceId ? { traceId: opts.traceId } : {}),
      },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
  }

  it("合法 JWT → ping 收 pong + traceId", async () => {
    const socket = connect({ token: validToken });
    await waitForEvent(socket, "connect");

    const ack = await new Promise<{ pong: true; traceId: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("ping ack timeout")),
          2_000,
        );
        socket.emit("ping", null, (res: { pong: true; traceId: string }) => {
          clearTimeout(timer);
          resolve(res);
        });
      },
    );
    expect(ack.pong).toBe(true);
    expect(typeof ack.traceId).toBe("string");
    expect(ack.traceId.length).toBeGreaterThan(0);

    socket.disconnect();
  });

  it("无 token → ping 触发 error envelope (code 2 UNAUTHORIZED) + disconnect", async () => {
    const socket = connect({});
    await waitForEvent(socket, "connect");

    const errorPromise = waitForEvent<{
      success: false;
      code: number;
      message: string;
      traceId?: string;
    }>(socket, "exception");
    socket.emit("ping");
    const err = await errorPromise;

    expect(err.success).toBe(false);
    expect(err.code).toBe(2); // CommonErrorCode.UNAUTHORIZED
    expect(typeof err.message).toBe("string");
    expect(err.traceId).toBeTruthy();

    // 服务端应主动 disconnect
    if (socket.connected) {
      await waitForEvent(socket, "disconnect");
    }
    expect(socket.connected).toBe(false);

    socket.disconnect();
  });

  it("上游 traceId → pong response 等于上游值", async () => {
    const upstream = "ws-trace-upstream-xyz";
    const socket = connect({ token: validToken, traceId: upstream });
    await waitForEvent(socket, "connect");

    const ack = await new Promise<{ pong: true; traceId: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("ping ack timeout")),
          2_000,
        );
        socket.emit("ping", null, (res: { pong: true; traceId: string }) => {
          clearTimeout(timer);
          resolve(res);
        });
      },
    );
    expect(ack.traceId).toBe(upstream);

    socket.disconnect();
  });
});
