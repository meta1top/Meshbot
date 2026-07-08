import { z } from "zod";

/**
 * 设备授权(device authorization grant)跨域 schema —— 云端(server-main REST)
 * 与本地轨(server-agent/cli 消费 REST 响应)共享同一套字段约定。
 */

export const DeviceAuthStartSchema = z.object({
  deviceName: z
    .string()
    .min(1, { message: "validation.required" })
    .max(128, { message: "validation.stringTooLong" }),
  platform: z
    .string()
    .max(32, { message: "validation.stringTooLong" })
    .default(""),
  codeChallenge: z.string().length(64, { message: "validation.invalidFormat" }),
  redirectUri: z
    .string()
    .url({ message: "validation.invalidFormat" })
    .max(255)
    .optional(),
});
export type DeviceAuthStartInput = z.infer<typeof DeviceAuthStartSchema>;

export const DeviceAuthApproveSchema = z.object({
  requestId: z.string().min(1),
});
export type DeviceAuthApproveInput = z.infer<typeof DeviceAuthApproveSchema>;

export const DeviceAuthExchangeSchema = z.object({
  requestId: z.string().min(1),
  userCode: z.string().min(1).max(32),
  codeVerifier: z.string().min(16).max(128),
  machineId: z.string().max(80).nullish(),
});
export type DeviceAuthExchangeInput = z.infer<typeof DeviceAuthExchangeSchema>;

export const DeviceSwitchOrgSchema = z.object({ orgId: z.string().min(1) });
export type DeviceSwitchOrgInput = z.infer<typeof DeviceSwitchOrgSchema>;

export interface DeviceAuthStartResult {
  requestId: string;
  verifyUrl: string;
}
export interface DeviceAuthExchangeResult {
  deviceToken: string;
  user: { id: string; email: string; displayName: string };
  orgId: string | null;
}
export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** 该设备是否为当前请求方设备（device token 请求时判定；用户 JWT 请求恒 false）。 */
  isCurrent: boolean;
}
