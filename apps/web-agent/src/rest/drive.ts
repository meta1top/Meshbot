"use client";

import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** 网盘节点（与 server-main NodeView 对齐）。 */
export interface DriveNode {
  id: string;
  type: "file" | "folder";
  name: string;
  sizeBytes: number;
  mime: string | null;
  status: "uploading" | "ready";
  permission: "owner" | "editor" | "viewer";
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 节点共享授权条目。 */
export interface DriveGrant {
  granteeType: "org" | "user";
  granteeId: string;
  permission: "viewer" | "editor";
}

/** 网盘节点列表查询 key（含 parentId）。 */
export const driveNodesQueryKey = ["drive", "nodes"] as const;

/** 网盘配额查询 key。 */
export const driveQuotaQueryKey = ["drive", "quota"] as const;

/** 获取指定目录下的节点列表；parentId 为 null 表示根目录。 */
export async function fetchNodes(
  parentId: string | null,
): Promise<DriveNode[]> {
  const { data } = await apiClient.get<DriveNode[]>("/api/drive/nodes", {
    params: parentId ? { parentId } : {},
  });
  return data;
}

/** 获取共享给我的节点列表。 */
export async function fetchShared(): Promise<DriveNode[]> {
  const { data } = await apiClient.get<DriveNode[]>("/api/drive/shared");
  return data;
}

/** 获取当前账号的存储配额（已用 / 上限，单位 bytes）。 */
export async function fetchQuota(): Promise<{ used: number; limit: number }> {
  const { data } = await apiClient.get<{ used: number; limit: number }>(
    "/api/drive/quota",
  );
  return data;
}

/** 在指定目录下创建文件夹。 */
export async function createFolder(
  parentId: string | null,
  name: string,
): Promise<DriveNode> {
  const { data } = await apiClient.post<DriveNode>("/api/drive/folders", {
    parentId,
    name,
  });
  return data;
}

/** 申请上传：返回 nodeId 与预签名 PUT URL。 */
export async function requestUpload(body: {
  name: string;
  parentId: string | null;
  size: number;
  mime: string;
}): Promise<{ nodeId: string; putUrl: string }> {
  const { data } = await apiClient.post<{ nodeId: string; putUrl: string }>(
    "/api/drive/uploads",
    body,
  );
  return data;
}

/** 上传完成确认：将节点状态由 uploading 切换为 ready。 */
export async function completeUpload(nodeId: string): Promise<DriveNode> {
  const { data } = await apiClient.post<DriveNode>(
    `/api/drive/uploads/${nodeId}/complete`,
    {},
  );
  return data;
}

/** 获取文件的临时访问 URL（含 TTL，单位秒）。 */
export async function getFileUrl(
  id: string,
): Promise<{ url: string; ttl: number }> {
  const { data } = await apiClient.get<{ url: string; ttl: number }>(
    `/api/drive/files/${id}/url`,
  );
  return data;
}

/** 重命名节点。 */
export async function renameNode(id: string, name: string): Promise<void> {
  await apiClient.patch(`/api/drive/nodes/${id}`, { name });
}

/** 移动节点到指定目录；parentId 为 null 表示移至根目录。 */
export async function moveNode(
  id: string,
  parentId: string | null,
): Promise<void> {
  await apiClient.patch(`/api/drive/nodes/${id}`, { parentId });
}

/** 删除节点（文件或文件夹，文件夹递归删除）。 */
export async function deleteNode(id: string): Promise<void> {
  await apiClient.delete(`/api/drive/nodes/${id}`);
}

/** 获取节点的共享授权列表。 */
export async function getGrants(id: string): Promise<DriveGrant[]> {
  const { data } = await apiClient.get<DriveGrant[]>(
    `/api/drive/nodes/${id}/grants`,
  );
  return data;
}

/** 全量更新节点的共享授权列表（幂等覆盖）。 */
export async function setGrants(
  id: string,
  grants: DriveGrant[],
): Promise<void> {
  await apiClient.put(`/api/drive/nodes/${id}/grants`, { grants });
}

/** 查询指定目录的子节点列表。 */
export function useDriveNodes(parentId: string | null) {
  return useQuery({
    queryKey: [...driveNodesQueryKey, parentId],
    queryFn: () => fetchNodes(parentId),
  });
}

/** 查询共享给我的节点列表。 */
export function useDriveShared() {
  return useQuery({
    queryKey: ["drive", "shared"],
    queryFn: fetchShared,
  });
}

/** 查询当前账号的存储配额。 */
export function useDriveQuota() {
  return useQuery({
    queryKey: driveQuotaQueryKey,
    queryFn: fetchQuota,
  });
}

/** 创建文件夹 mutation；成功后失效所在目录的节点列表。 */
export function useCreateFolder(parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createFolder(parentId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...driveNodesQueryKey, parentId] });
    },
  });
}

/** 申请上传 mutation。 */
export function useRequestUpload() {
  return useMutation({
    mutationFn: requestUpload,
  });
}

/** 上传完成确认 mutation；成功后失效父目录的节点列表。 */
export function useCompleteUpload(parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: completeUpload,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...driveNodesQueryKey, parentId] });
    },
  });
}

/** 重命名节点 mutation；成功后失效父目录节点列表。 */
export function useRenameNode(parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renameNode(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...driveNodesQueryKey, parentId] });
    },
  });
}

/** 移动节点 mutation；成功后失效源目录与目标目录的节点列表。 */
export function useMoveNode(fromParentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      moveNode(id, parentId),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: [...driveNodesQueryKey, fromParentId] });
      qc.invalidateQueries({
        queryKey: [...driveNodesQueryKey, variables.parentId],
      });
    },
  });
}

/** 删除节点 mutation；成功后失效父目录节点列表。 */
export function useDeleteNode(parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteNode,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...driveNodesQueryKey, parentId] });
    },
  });
}

/** 公开分享链接条目。 */
export interface ShareLinkView {
  id: string;
  token: string;
  url: string;
  expiresAt: string | null;
  requiresPassword: boolean;
  createdAt: string;
}

/** 创建公开分享链接。 */
export async function createShareLink(
  nodeId: string,
  body: { expiresInDays?: number | null; password?: string },
): Promise<{ token: string; url: string }> {
  const { data } = await apiClient.post<{ token: string; url: string }>(
    `/api/drive/nodes/${nodeId}/share-links`,
    body,
  );
  return data;
}

/** 列出节点的全部公开分享链接。 */
export async function listShareLinks(nodeId: string): Promise<ShareLinkView[]> {
  const { data } = await apiClient.get<ShareLinkView[]>(
    `/api/drive/nodes/${nodeId}/share-links`,
  );
  return data;
}

/** 撤销指定公开分享链接。 */
export async function revokeShareLink(
  linkId: string,
): Promise<{ ok: boolean }> {
  const { data } = await apiClient.delete<{ ok: boolean }>(
    `/api/drive/share-links/${linkId}`,
  );
  return data;
}

/** 查询节点的公开分享链接列表。 */
export function useShareLinks(nodeId: string | null) {
  return useQuery({
    queryKey: ["drive", "share-links", nodeId],
    queryFn: () => listShareLinks(nodeId as string),
    enabled: !!nodeId,
  });
}

/** 创建公开分享链接 mutation；成功后失效链接列表。 */
export function useCreateShareLink(nodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { expiresInDays?: number | null; password?: string }) =>
      createShareLink(nodeId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drive", "share-links", nodeId] });
    },
  });
}

/** 撤销公开分享链接 mutation；成功后失效链接列表。 */
export function useRevokeShareLink(nodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => revokeShareLink(linkId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drive", "share-links", nodeId] });
    },
  });
}

/** 获取节点授权列表查询。 */
export function useGrants(id: string | null) {
  return useQuery({
    queryKey: ["drive", "grants", id],
    queryFn: () => getGrants(id as string),
    enabled: id != null,
  });
}

/** 全量设置节点授权 mutation；成功后失效授权列表。 */
export function useSetGrants(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grants: DriveGrant[]) => setGrants(id, grants),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drive", "grants", id] });
    },
  });
}
