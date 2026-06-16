import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server } from "socket.io";
import {
  io as createClient,
  type Socket as ClientSocket,
} from "socket.io-client";

const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6380);

async function redisReachable(): Promise<boolean> {
  const probe = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await probe.connect();
    await probe.quit();
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
}

interface Node {
  io: Server;
  http: HttpServer;
  port: number;
  pub: Redis;
  sub: Redis;
  close: () => Promise<void>;
}

/** 起一个挂了 redis adapter 的 socket.io Server（websocket-only）。 */
async function startNode(): Promise<Node> {
  const pub = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  const sub = pub.duplicate();
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  io.adapter(createAdapter(pub, sub));
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  return {
    io,
    http,
    port,
    pub,
    sub,
    close: async () => {
      io.close();
      await new Promise<void>((r) => http.close(() => r()));
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}

describe("IM 多 pod fan-out（Redis adapter）", () => {
  let skip = false;

  beforeAll(async () => {
    if (!(await redisReachable())) {
      skip = true;
      console.warn(
        `[im-multipod] Redis(${REDIS_HOST}:${REDIS_PORT}) 不可达，skip`,
      );
    }
  });

  it("A 实例房间 emit → 连在 B 实例的客户端收到", async () => {
    if (skip) return;
    const a = await startNode();
    const b = await startNode();
    b.io.on("connection", (s) => {
      s.join("room1");
    });

    const client: ClientSocket = createClient(`http://localhost:${b.port}`, {
      transports: ["websocket"],
      reconnection: false,
    });
    await new Promise<void>((res, rej) => {
      client.on("connect", () => res());
      client.on("connect_error", rej);
    });
    await new Promise((r) => setTimeout(r, 200));

    const got = new Promise<string>((res) => {
      client.on("ping-room", (msg: string) => res(msg));
    });
    a.io.to("room1").emit("ping-room", "hello-cross-node");

    await expect(got).resolves.toBe("hello-cross-node");

    client.close();
    await a.close();
    await b.close();
  }, 15_000);
});
