/** 邀请配置切片（由 server-main 的 AppConfig.invitation 提供）。 */
export interface AppConfigInvitation {
  expiresDays: number;
}

/** DI token。server-main 在 MainModule 装配时用 useValue 提供。 */
export const INVITATION_CONFIG = Symbol("INVITATION_CONFIG");
