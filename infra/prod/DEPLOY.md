# meshbot 云端轨部署 Runbook（一次性准备）

前置：infra 的 `pgvector` / `redis` / `nacos` / `minio` 已在外部网络 `meta1` 常驻。
以下命令在**部署宿主机**执行（meshbot 与 infra 两仓库均已 clone 到宿主机）。
设计细节见 `docs/superpowers/specs/2026-07-07-cloud-deploy-gitlab-ci-design.md`。

## 1. 数据库（pgvector 上建库 + 手动跑迁移）

DDL 由 DBA 手动执行，服务任何模式不自动建表。

```bash
# 建库
docker exec -i pgvector psql -U postgres -c "CREATE DATABASE meshbot_main;"
# 按文件名顺序跑迁移
cd <meshbot 仓库根>
for f in $(ls apps/server-main/migrations/*.sql | sort); do
  echo ">> $f"
  docker exec -i pgvector psql -U postgres -d meshbot_main < "$f"
done
# 校验：应列出 meshbot 的表
docker exec -i pgvector psql -U postgres -d meshbot_main -c "\dt"
```

## 2. MinIO（建 bucket）

```bash
docker run --rm --network meta1 minio/mc sh -c "\
  mc alias set m http://minio:9000 minioadmin changeme123456 && \
  mc mb --ignore-existing m/meshbot-skills && \
  mc ls m"
# 建议：为 meshbot 单独建 service account（勿用 root），记下 accessKey/secretKey 填进 Nacos：
# docker run --rm --network meta1 minio/mc sh -c "mc alias set m http://minio:9000 minioadmin changeme123456 && mc admin user svcacct add m minioadmin"
```

## 3. Nacos（namespace meshbot + dataId meshbot-server-main.yaml）

在 Nacos 控制台（`https://<nacos 对外地址>/nacos`，或宿主 `http://<host>:8848/nacos`）：
1. 命名空间 → 新建 `meshbot`（**记下生成的 namespace id**——`NACOS_NAMESPACE` 视客户端可能吃 id 而非名字，见 §7 注意）。
2. 配置列表 → 新建：dataId `meshbot-server-main.yaml`，group `DEFAULT_GROUP`，格式 `YAML`，内容（按实际填 secret）：

```yaml
port: 3200
database:
  type: postgres
  host: pgvector
  port: 5432
  username: postgres
  password: <pgvector 口令>
  database: meshbot_main
  synchronize: false
  autoLoadEntities: true
  logging: [error, warn, migration]
jwt:
  secret: <openssl rand -base64 48>
  expires: 7d
redis:
  host: redis
  port: 6379
  db: 0
  password: changeme-redis
security:
  encryption-key: <≥32 字符随机串>
assets:
  minio:
    endPoint: assets.meta1.top
    port: 443
    useSSL: true
    accessKey: <minio accessKey>
    secretKey: <minio secretKey>
    bucket: meshbot-skills
webMainBase: https://bot.meta1.top
# 可选：邮件（阿里云 DirectMail）。省略则邀请码只打服务日志。
# email:
#   endpoint: dm.aliyuncs.com
#   account-name: noreply@mail.meta1.top
#   access-key-id: <ak>
#   access-key-secret: <sk>
#   from: meshbot
```

> `MESHBOT_NODE_ID` 不在 Nacos，由容器 env 提供（compose）。配了 `redis` 必须给它，否则 server-main 拒绝启动。

## 4. GitLab 仓库 + CI/CD 变量

```bash
# 在 git.meta1.top 建 meshbot 项目后，本地加 remote 并推 main
cd <meshbot 仓库根>
git remote add gitlab https://git.meta1.top/<group>/meshbot.git
git push gitlab <当前分支>:main   # 首次；之后正常 push main 触发流水线
```

项目 Settings → CI/CD → Variables 添加（敏感项勾 Masked）：

| Key | Value | Masked |
|-----|-------|--------|
| `NACOS_SERVER_ADDR` | `nacos:8848` | |
| `NACOS_NAMESPACE` | `<meshbot namespace id>` | |
| `NACOS_DATA_ID` | `meshbot-server-main.yaml` | |
| `NACOS_USERNAME` | `<nacos 用户>` | |
| `NACOS_PASSWORD` | `<nacos 口令>` | ✓ |
| `MESHBOT_NODE_ID` | `0` | |

（`REGISTRY_IMAGE` / `IMAGE_TAG` 由 `.gitlab-ci.yml` 从内置变量推导，无需手配。确保项目已启用 Container Registry。）

## 5. nginx 三域名反代（infra 仓库）

在 infra 仓库 `nginx/conf.d/` 加 `bot.meta1.top.conf` / `api-bot.meta1.top.conf` / `assets.meta1.top.conf`（内容见实施 plan Task 4），宿主机 reload：

```bash
cd <infra 仓库根>
docker compose -f nginx/docker-compose.yml exec nginx nginx -t
docker compose -f nginx/docker-compose.yml exec nginx nginx -s reload
```

## 6. DNS

`bot` / `api-bot` / `assets`.meta1.top 均解析到宿主机 IP（泛域名证书 `*.meta1.top` 已覆盖）。

```bash
for h in bot api-bot assets; do echo -n "$h.meta1.top -> "; dig +short $h.meta1.top; done
```

## 7. 首次部署与验收

推 main 触发流水线，或宿主机手动：
```bash
cd <meshbot 仓库根>
cp infra/prod/.env.prod.example infra/prod/.env.prod   # 填 REGISTRY_IMAGE/NACOS_*
docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod up -d
```

验收（对应 spec §8）：
```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep meshbot   # 两容器 Up (healthy)
curl -sSf https://api-bot.meta1.top/api/health                # {"status":"ok",...}
curl -sSI https://bot.meta1.top/ | head -1                    # 200/307
```
浏览器打开 `https://bot.meta1.top` 完成注册/登录，DevTools 里 `/socket.io/` WS `101`；建分享链接下载，确认 presigned URL host = `https://assets.meta1.top/...` 可下载。

## 上线前两个纯运维前提（决定首次 deploy 成败，见 spec §9）

- **Nacos 命名空间**：deploy 传的 `NACOS_NAMESPACE=meshbot`；确认 Nacos 客户端吃的是「命名空间名」还是「命名空间 id」，并保证与控制台创建的一致。
- **MinIO presigned**：Nacos 里 `assets.minio.endPoint=assets.meta1.top` 与 nginx `assets.meta1.top` 的 `proxy_set_header Host $host` 必须成对，否则 SigV4 校验 403。
