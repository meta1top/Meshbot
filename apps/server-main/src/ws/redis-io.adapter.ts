import { Logger } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import type { Server, ServerOptions } from "socket.io";
import type { RedisConfig } from "../config/app-config.schema";

/**
 * 多 pod IM 适配器。
 * - 始终强制 websocket-only（免 ingress 会话粘性）。
 * - 配了 Redis → 给 socket.io server 挂 @socket.io/redis-adapter（pub/sub），使 room
 *   广播 / fetchSockets / 远程 socket 操作跨 pod 生效；否则默认内存 adapter（单 pod）。
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  /** 配了 Redis 则建 pub/sub 连接并构建 redis adapter；无则单 pod，幂等。 */
  async connectToRedis(redisConfig: RedisConfig | undefined): Promise<void> {
    if (!redisConfig) {
      return;
    }
    if (this.adapterConstructor) {
      return;
    }
    const make = (): Redis => {
      const client = new Redis({
        host: redisConfig.host,
        port: redisConfig.port,
        db: redisConfig.db,
        password: redisConfig.password,
        maxRetriesPerRequest: 3,
        lazyConnect: false,
      });
      client.on("error", (err: Error) => {
        this.logger.error(
          `IM Redis adapter 连接错误（将自动重连）：${err.message}`,
        );
      });
      return client;
    };
    this.pub = make();
    this.sub = this.pub.duplicate();
    this.adapterConstructor = createAdapter(this.pub, this.sub);
  }

  /** 是否多 pod（已挂 redis adapter）。 */
  isClustered(): boolean {
    return this.adapterConstructor !== null;
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      transports: ["websocket"],
    }) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  /** 关闭 pub/sub 连接（进程退出时调用）。 */
  async close(): Promise<void> {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
  }
}
