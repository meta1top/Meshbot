# meshbot 云端轨生产部署（infra/prod）

`server-main` + `web-main` 两个应用容器,**复用** infra 共享服务(外部 docker 网络 `meta1` 上常驻的 `pgvector` / `redis` / `nacos` / `minio`)。compose **不自起** DB / Redis —— 只拉 registry 镜像、注入 Nacos 引导变量、挂到 `meta1` 网络。

CI/CD:`push main → GitLab CI 构建镜像 push hub.meta1.top → 同机 docker compose pull && up -d`。设计细节见 spec `docs/superpowers/specs/2026-07-07-cloud-deploy-gitlab-ci-design.md`。

## 编排

| 容器 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| `meshbot-server-main` | `${REGISTRY_IMAGE}/server-main:${IMAGE_TAG}` | 内部 3200 | 云协同后端(API + WS) |
| `meshbot-web-main` | `${REGISTRY_IMAGE}/web-main:${IMAGE_TAG}` | 内部 3000 | 云协同前端(Next standalone SSR) |

两个容器都**不暴露宿主端口**,由 infra 仓库的 `nginx`(同在 `meta1` 网络)按容器名反代三个域名:

- `bot.meta1.top` → `meshbot-web-main:3000`(web-main,`/api` 与 `/socket.io` 同源分发到 server-main)
- `api-bot.meta1.top` → `meshbot-server-main:3200`(桌面端 / CLI / 本地轨反向通道直连)
- `assets.meta1.top` → `minio:9000`(MinIO presigned 上传 / 下载出口)

## 配置

真实 secret(DB / JWT / 加密 key / 邮件 / MinIO)**全在 Nacos** 的 `meshbot-server-main.yaml`(dataId),不落在本目录任何文件。compose 与 `.env.prod` 只含引导变量:

| 变量 | 说明 |
|------|------|
| `REGISTRY_IMAGE` | 镜像仓库前缀,= GitLab 内置 `$CI_REGISTRY_IMAGE`(形如 `hub.meta1.top/<group>/meshbot`) |
| `IMAGE_TAG` | 镜像 tag,deploy 用 `$CI_COMMIT_SHORT_SHA`(保留回滚史),手动可用 `latest` |
| `NACOS_SERVER_ADDR` / `NACOS_NAMESPACE` / `NACOS_DATA_ID` / `NACOS_USERNAME` / `NACOS_PASSWORD` | Nacos 引导 |
| `MESHBOT_NODE_ID` | Snowflake 节点 ID,多副本必唯一,单副本 `0` |

样例见 `.env.prod.example`。deploy job 从 GitLab CI/CD 变量自动渲染 `infra/prod/.env.prod`;手动部署时 `cp .env.prod.example .env.prod` 填值。`.env.prod` 已被仓库根 `.gitignore` 忽略,勿提交。

> fail-fast:server-main 生产环境若 `jwt.secret` / `security.encryptionKey` 仍是仓库内置 dev 值,或配了 redis 却无 `MESHBOT_NODE_ID`,启动即抛错(漏配 Nacos 的保护)。

## 起动

```bash
# repo root,.env.prod 已就位(CI 渲染或手动 cp 填值)
docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod pull
docker compose -f infra/prod/docker-compose.prod.yml --env-file infra/prod/.env.prod up -d
docker compose -f infra/prod/docker-compose.prod.yml logs -f server-main
```

## 数据库迁移

云端轨用纯 SQL DDL 文件(`apps/server-main/migrations/`),由 **DBA 手动执行**;服务任何模式都**不自动建表 / 跑迁移**。上线前须先在 `meshbot_main` 库跑完迁移。

## 一次性准备与验收

首次上线的一次性准备(建 `meshbot_main` 库 / 建 MinIO bucket / 写 Nacos 配置 / 配 GitLab CI/CD 变量 / DNS 解析 `bot`·`api-bot`·`assets`.meta1.top / infra 仓库加三个 nginx conf)与上线验收清单,详见:

- 设计 spec:`docs/superpowers/specs/2026-07-07-cloud-deploy-gitlab-ci-design.md`
- 后续操作手册:`infra/prod/DEPLOY.md`(建库 / 卷 / Nacos 键值等 runbook)
