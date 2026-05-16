# meshbot 生产形态部署（infra/prod）

最小可用的 docker-compose 编排：`postgres + redis + server-main`。
适用于单机部署 / 小规模生产 / 演示环境。多机集群 / 高可用 / k8s 推 Phase 5+。

## 起动

```bash
cd infra/prod
cp .env.prod.example .env.prod
$EDITOR .env.prod   # 改下面三个 secret

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
docker compose -f docker-compose.prod.yml logs -f server-main
```

健康检查（容器名 `meshbot-prod-server-main`）：

```bash
curl http://localhost:3200/api/health
# 期望：{"status":"up","message":"成功"}
```

## 必填 secret

| 变量 | 说明 | 生成 |
|------|------|------|
| `POSTGRES_PASSWORD` | Postgres 密码 | `openssl rand -base64 24` |
| `JWT_SECRET` | JWT 签名密钥（≥ 32 字节） | `openssl rand -base64 48` |

可选：`POSTGRES_USER` / `POSTGRES_DB` / `JWT_EXPIRES` / `SERVER_MAIN_PORT` 有默认值。

## 数据库迁移

Phase 4 阶段，server-main image 默认 `migrationsRun: false`（production 路径），需要手工跑一次：

```bash
docker compose -f docker-compose.prod.yml exec -e DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB server-main \
  node -e "require('./node_modules/@meshbot/server-main/dist/data-source.cli.js').default.initialize().then(ds=>ds.runMigrations()).then(()=>process.exit(0))"
```

> Phase 5 计划：加 init container 自动跑迁移，或把 migrationsRun 切回 true（接受启动慢一点的代价）。

## 数据存放

- `meshbot-prod-postgres` volume：Postgres 数据
- `meshbot-prod-redis` volume：Redis AOF/RDB

升级 / 重启：`docker compose up -d` 复用 volume；`down -v` 会清空，请先备份：

```bash
# 备份 Postgres
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup-$(date +%F).sql
```

## 端口

默认仅 server-main `3200` 暴露到 host；Postgres / Redis 端口在 compose 内部网络内（更安全）。

如需 host 端口（调试）：取消 compose 文件中 `ports:` 注释。

## 不在 Phase 4 范围

- 多机部署 / k8s / Helm（Phase 5）
- Sentinel / Cluster Redis HA（Phase 5）
- CDN / 镜像分发（Phase 5）
- TLS 终结（Nginx / Caddy 反代）—— 自行外接
- 监控（Sentry / OTel / Grafana）—— 用户明确推迟到 Phase 5+
