/** 账号运行时生命周期事件（进程内 EventEmitter2）。 */
export const ACCOUNT_EVENTS = {
  runtimeCreated: "account.runtime.created",
  runtimeTeardown: "account.runtime.teardown",
} as const;

export interface AccountRuntimeEvent {
  cloudUserId: string;
}
