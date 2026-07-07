/**
 * L3 影子渲染专属桥事件（server-agent 进程内 EventEmitter2 事件名，**不是**
 * relay 线协议——relay 协议见 `libs/types` 的 `AgentRunFrame` / `agent.run.*`）。
 *
 * 背景：`RemoteRunService.onFrame` 收到 B 侧回流的运行帧后，若直接用原始
 * `SESSION_WS_EVENTS.*` 名重发到 A 的共享全局 EventEmitter2 总线，会撞上
 * 该总线上其它按事件名订阅的本地副作用消费者——典型如
 * `RunnerService.onToolCallEnd`（`@OnEvent(SESSION_WS_EVENTS.runToolCallEnd)`）
 * 无 session 校验、无条件把 tool 结果写入 A 本地 SQLite，导致每次远程 tool
 * 调用都在 A 本机留下一条属于 B 会话的孤儿 `role=tool` 行（违反「远程隧道不落
 * A 本地 DB」的约束）。
 *
 * 修法：影子渲染改发这个专属事件，只有 `SessionGateway` 订阅并转发到
 * `room=payload.sessionId`；`RunnerService` 等本地 run 消费者绝不监听它，
 * 从根上切断污染路径。
 */
export const REMOTE_SHADOW_FRAME_EVENT = "remote.shadow.frame";

/** `REMOTE_SHADOW_FRAME_EVENT` 载荷：原始 SESSION_WS_EVENTS.* 事件名 + 该事件的 payload。 */
export interface RemoteShadowFramePayload {
  event: string;
  payload: unknown;
}
