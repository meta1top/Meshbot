/**
 * DRIVE_PORT —— libs/agent → server-agent 解耦端口（网盘工具）。
 * 5 个网盘工具经此端口调用 server-agent 的 DriveToolService 实现。
 * 无 server-agent 环境（工具单测）可 mock。
 */
export const DRIVE_PORT = Symbol("DRIVE_PORT");

/** 网盘工具端口（实现见 server-agent DriveToolService）。 */
export interface DrivePort {
  /** 列目录（parentId=null 根）。返回 JSON 字符串。 */
  list(parentId: string | null): Promise<string>;
  /** 建文件夹。 */
  mkdir(parentId: string | null, name: string): Promise<string>;
  /** 上传 workspace 文件到网盘。 */
  upload(
    path: string,
    parentId: string | null,
    name: string | undefined,
  ): Promise<string>;
  /** 下载网盘文件到 workspace。 */
  download(fileId: string, destPath: string): Promise<string>;
  /** 共享（HITL）：挂起等用户确认后改 ACL。 */
  share(
    args: {
      nodeId: string;
      shareWith: string;
      permission: "viewer" | "editor";
      sessionId: string;
      toolCallId: string;
    },
    signal: AbortSignal,
  ): Promise<string>;
}
