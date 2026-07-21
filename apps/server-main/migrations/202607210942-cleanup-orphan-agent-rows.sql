-- 清理 agent 表里的孤儿行（幽灵注册记录）。DBA 手动执行；幂等。
--
-- ⚠️ 这是**数据清理**，不是 schema 变更，且不可回滚。请务必先跑「第一步」的
-- 查询看清会删掉什么，确认无误再跑「第二步」的 DELETE。
--
-- ============================================================================
-- 背景：为什么会有孤儿行，以及为什么不能"全删"
-- ============================================================================
-- `agent` 表是设备侧 remote_enabled Agent 的云端镜像，用**软删**对账
-- （`libs/main/src/services/cloud-agent.service.ts`）：设备不再上报某个 Agent 时
-- 置 `deleted_at`，而同一个 `(device_id, local_agent_id)` 再次出现时会把
-- `deleted_at` 置回 NULL——**复活，并保留原来的云端 agent id**。
--
-- 这个 id 稳定性不是内部细节：远程寻址按云端 agent id 走，且它出现在
--   - 浏览器 URL：`/assistant/[agentId]`
--   - localStorage：`meshbot.mainSidebarExpandedAgents`（侧栏展开态）
-- 硬删一条**还可能复活**的软删行，等于让该 Agent 下次以新 id 出现，用户的书签
-- 和展开态会静默失效。
--
-- 所以只清理「**不可能再复活**」的两类：宿主设备已撤销、或宿主设备行已不存在。
-- 设备撤销是不可逆的（`libs/main/src/services/device.service.ts` 只有置
-- `revoked_at` 的路径，没有置回 NULL 的），所以这两类的复活前提永远不成立。
--
-- 「设备还活着、只是这个 Agent 被软删了」这一类**不在本次范围**——它随时可能
-- 复活，删了就丢 id 稳定性。若确实要清（比如确认某些 Agent 永久下线了），见文件
-- 末尾「第三步（可选）」，那需要你明确给出时间阈值。

-- ============================================================================
-- 第一步：先看会删掉什么（只读，随便跑）
-- ============================================================================

-- 1a. 分类计数
SELECT
  CASE
    WHEN d."id" IS NULL              THEN '宿主设备行已不存在'
    WHEN d."revoked_at" IS NOT NULL  THEN '宿主设备已撤销'
  END AS reason,
  count(*) AS rows_to_delete
FROM "agent" a
LEFT JOIN "device" d ON d."id" = a."device_id"
WHERE d."id" IS NULL OR d."revoked_at" IS NOT NULL
GROUP BY 1
ORDER BY 1;

-- 1b. 明细（确认里面没有你还想留的）
SELECT
  a."id",
  a."name",
  a."device_id",
  d."name"        AS device_name,
  d."revoked_at"  AS device_revoked_at,
  a."deleted_at"  AS agent_deleted_at,
  a."last_synced_at"
FROM "agent" a
LEFT JOIN "device" d ON d."id" = a."device_id"
WHERE d."id" IS NULL OR d."revoked_at" IS NOT NULL
ORDER BY a."updated_at" DESC;

-- 1c. 对照：本次**不会**动的软删行（设备还活着，随时可能复活）
SELECT count(*) AS soft_deleted_but_device_alive
FROM "agent" a
JOIN "device" d ON d."id" = a."device_id"
WHERE a."deleted_at" IS NOT NULL AND d."revoked_at" IS NULL;

-- ============================================================================
-- 第二步：执行清理（确认第一步的结果之后再跑）
-- ============================================================================
-- 幂等：重复执行第二次会删 0 行。
-- 注意这里**不限定 deleted_at**——宿主设备都已经撤销/消失了，无论该 Agent 当时
-- 是不是软删态，这条注册记录都已失去意义（设备再也连不上来）。

DELETE FROM "agent" a
USING (
  SELECT a2."id"
  FROM "agent" a2
  LEFT JOIN "device" d ON d."id" = a2."device_id"
  WHERE d."id" IS NULL OR d."revoked_at" IS NOT NULL
) victims
WHERE a."id" = victims."id";

-- ============================================================================
-- 第三步（可选，需要你先定阈值）：清理长期未复活的软删行
-- ============================================================================
-- 默认**不执行**。这类行的宿主设备仍然活着，复活是可能的；删掉会丢 id 稳定性
-- （见文件顶部说明）。若确认某些 Agent 永久下线、且能接受书签/展开态失效，
-- 把下面的阈值改成你要的天数再取消注释。
--
-- DELETE FROM "agent" a
-- USING (
--   SELECT a2."id"
--   FROM "agent" a2
--   JOIN "device" d ON d."id" = a2."device_id"
--   WHERE a2."deleted_at" IS NOT NULL
--     AND d."revoked_at" IS NULL
--     AND a2."deleted_at" < now() - interval '90 days'   -- ← 阈值在这里
-- ) victims
-- WHERE a."id" = victims."id";
