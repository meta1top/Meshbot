# meshbot 本地开发依赖（dev infra）

仅供本地开发使用。生产部署见 `infra/prod/`（Phase 4 Track C）。

## 起停

```bash
pnpm dev:db:up       # 启动 postgres + redis（后台）
pnpm dev:db:logs     # 跟随日志
pnpm dev:db:down     # 停止（保留数据）
pnpm dev:db:reset    # 停止并清空 volume（破坏数据）
```

## 默认连接

| 服务 | 容器 | 宿主端口 | 连接字符串 |
|------|------|---------|-----------|
| Postgres | `meshbot-dev-postgres` | `5432` | `postgresql://meshbot:meshbot@localhost:5432/meshbot_main` |
| Redis | `meshbot-dev-redis` | `6380` | `redis://localhost:6380` |

注：Redis 宿主端口是 **6380**（容器内仍 6379），避免与本机其它项目的 redis 6379 冲突。

## 端口冲突

如果宿主端口已被占用：

```yaml
# docker-compose.dev.yml
services:
  postgres:
    ports:
      - "5433:5432"   # 改宿主端口
  redis:
    ports:
      - "6381:6379"
```

同步修改 `apps/server-main/.env.development`：

```
DATABASE_URL=postgresql://meshbot:meshbot@localhost:5433/meshbot_main
REDIS_URL=redis://localhost:6381
```

## 健康检查排查

```bash
docker exec meshbot-dev-postgres pg_isready -U meshbot -d meshbot_main
docker exec meshbot-dev-redis redis-cli ping
docker inspect meshbot-dev-postgres --format='{{.State.Health.Status}}'
docker inspect meshbot-dev-redis    --format='{{.State.Health.Status}}'
```

## 数据存放

- `meshbot-dev-postgres-data` volume：Postgres 数据，`dev:db:reset` 会清空
- `meshbot-dev-redis-data` volume：Redis AOF/RDB，`dev:db:reset` 会清空

## Redis 是否必需

不是。server-main `CommonModule.forRootAsync` 在 `REDIS_URL` 不设置时回退到 memory 兜底（进程内互斥锁 + LRU 缓存），开发体验完全相同。Redis 容器仅在以下场景需要：

- 跑 e2e 的 redis 链路（`describe.each([["memory"], ["redis"]])` 中的 redis case）
- 模拟多节点 / 多 server-main 实例共享锁与缓存
