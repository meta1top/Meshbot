# meshbot 本地开发依赖（dev infra）

仅供 Phase 3 起 server-main 本地开发使用。生产部署不走本目录。

## Postgres（server-main）

```bash
pnpm dev:db:up       # 启动后台
pnpm dev:db:logs     # 跟随日志
pnpm dev:db:down     # 停止（保留数据）
pnpm dev:db:reset    # 停止并清空 volume（破坏数据）
```

默认连接字符串：

```
postgresql://meshbot:meshbot@localhost:5432/meshbot_main
```

## 端口冲突

如果本地 5432 已被占用（如系统装了 Postgres），改 `docker-compose.dev.yml` 端口映射：

```yaml
ports:
  - "5433:5432"
```

并同步修改 `apps/server-main/.env.development` 中的 `DATABASE_URL` 端口。

## 健康检查排查

```bash
docker exec meshbot-dev-postgres pg_isready -U meshbot -d meshbot_main
docker inspect meshbot-dev-postgres --format='{{.State.Health.Status}}'
```

## 数据存放

数据落在 docker volume `meshbot-dev-postgres-data`，跟随容器生命周期。`dev:db:reset` 会清空。
