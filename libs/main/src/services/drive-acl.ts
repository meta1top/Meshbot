import type { CloudNode } from "../entities/cloud-node.entity";
import type { CloudNodeGrant } from "../entities/cloud-node-grant.entity";

/** 网盘权限级别：owner > editor > viewer。 */
export type DrivePermission = "owner" | "editor" | "viewer";

export const RANK: Record<DrivePermission, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

/**
 * 判定用户对某节点的有效权限（Google Drive 式继承）。
 * @param ctx 当前用户 + 当前组织（org 来自 token.orgId）
 * @param node 目标节点（owner 恒为全权）
 * @param chainGrants node 自身 + 全部祖先的 grant 合集（调用方查好传入）
 * @returns 最高命中权限；无命中且非 owner → null（无权访问）
 */
export function resolvePermission(
  ctx: { userId: string; orgId: string },
  node: CloudNode,
  chainGrants: CloudNodeGrant[],
): DrivePermission | null {
  if (node.ownerUserId === ctx.userId) {
    return "owner";
  }
  let best: DrivePermission | null = null;
  for (const g of chainGrants) {
    const hit =
      (g.granteeType === "user" && g.granteeId === ctx.userId) ||
      (g.granteeType === "org" && g.granteeId === ctx.orgId);
    if (!hit) continue;
    const p = g.permission as DrivePermission;
    if (best === null || RANK[p] > RANK[best]) {
      best = p;
    }
  }
  return best;
}
