"use client";

import type {
  AgentRunControlInput,
  AgentRunEnd,
  AgentRunFrame,
  AgentRunStartInput,
  DeviceQueryKind,
  DeviceQueryRequestInput,
} from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import type {
  HistoryResponse,
  PendingResponse,
  SessionSummary,
} from "@meshbot/types-agent";
import { clientSnowflakeId } from "@meshbot/web-common";
import {
  MulticastRunEvents,
  RemoteRunTracker,
  type SessionTransport,
} from "@meshbot/web-common/session";
import { remoteQuery } from "./device-query";
import { getImSocket } from "./im-socket";

/**
 * web-main（B 端浏览器）远程会话 `SessionTransport`：用户 `ws/im` socket 单例
 * （`getImSocket()`）直连 L3 协议帧流——不同于 web-agent，这里没有一层
 * server-agent 帮忙把远程帧影子重发进本地 `SESSION_WS_EVENTS` 总线，浏览器
 * 直接是 L3 的发起方（A），`device.query.*`/`agent.run.*` 六个事件都在这条
 * socket 上原样收发（`im.gateway.ts` 的 `RunRequester` kind:"user" 分支）。
 *
 * 纯逻辑单元（无 socket 依赖，见 `packages/web-common/src/session/`）：
 * - {@link RemoteRunTracker}：run 帧流归属过滤 + 乱序重排 + end 事件合成。
 * - {@link MulticastRunEvents}：`subscribe()` 的多播分发（见下）。
 *
 * deviceQuery 往返（`device.query.*`）走 `device-query.ts` 的**模块级单例**
 * （一个 client + 一个常驻 `deviceQueryResponse` 监听器），不绑 transport 实例——
 * 否则 remount 时会丢掉尚未 settle 的响应（详见该文件）。本工厂只注册
 * `agentRunFrame`/`agentRunEnd` 两个 run 帧监听器（随 transport 实例，`dispose` 摘除）。
 *
 * `subscribe()` 是**多播**语义（{@link MulticastRunEvents}），并发多路订阅同时
 * 生效：dispatch_subagent 的父子会话共享同一父 `streamId`（B 端按
 * `allowedSessions` 白名单把子会话事件也转发到这同一条流），父会话视图与
 * 嵌套子代理卡因此必须复用**同一个** transport 实例才能都收到帧——早期实现
 * 曾用单一 `current` 指针，后订阅者会覆盖前订阅者，导致先订阅的一方永久收不到
 * 帧（T11 报告 finding 1）。各订阅者内部（`useSessionStream` 的
 * `e.sessionId !== sessionId` 过滤）自行区分哪些广播事件属于自己的会话。
 *
 * 调用方应对同一 deviceId 用 `useMemo` 稳定一份 transport 实例（同 web-agent
 * 惯例），嵌套子代理卡复用父组件传入的同一实例（不再各自新建），并在 unmount
 * 时调用 {@link dispose} 释放三个 socket 监听器（子卡不自行 dispose，归父组件
 * 统一管理生命周期）。
 */
export function createRemoteSessionTransport(
  deviceId: string,
): SessionTransport {
  const socket = getImSocket();
  const runs = new RemoteRunTracker();
  const runEvents = new MulticastRunEvents();

  const onRunFrame = (frame: AgentRunFrame) => {
    for (const { event, payload } of runs.handleFrame(frame)) {
      runEvents.emit(event, payload);
    }
  };
  const onRunEnd = (end: AgentRunEnd) => {
    const synthesized = runs.handleEnd(end);
    if (synthesized) runEvents.emit(synthesized.event, synthesized.payload);
  };
  // deviceQueryResponse 监听器不在此注册——它挂在 device-query.ts 的模块级单例上
  // （见该文件说明：per-instance 监听器会在 remount 时丢掉尚未 settle 的响应）。
  socket.on(IM_WS_EVENTS.agentRunFrame, onRunFrame);
  socket.on(IM_WS_EVENTS.agentRunEnd, onRunEnd);

  const query = (
    kind: DeviceQueryKind,
    params: DeviceQueryRequestInput["params"],
  ) => remoteQuery(deviceId, kind, params);

  const control = (body: AgentRunControlInput) =>
    socket.emit(IM_WS_EVENTS.agentRunControl, body);

  return {
    capabilities: { localRun: false },

    async listSessions() {
      return (await query("sessions", {})) as SessionSummary[];
    },

    async fetchHistory(sessionId, opts) {
      return (await query("history", {
        sessionId,
        before: opts?.before,
        limit: opts?.limit,
      })) as HistoryResponse;
    },

    async startRun(input) {
      // messageId（本地乐观插入气泡 id）不使用：远程续写由 B 侧自行生成
      // messageId（randomUUID），前端无法提前得知，契约注释已明确此限制。
      const streamId = clientSnowflakeId();
      runs.register(streamId, input.sessionId ?? null);
      socket.emit(IM_WS_EVENTS.agentRunStart, {
        streamId,
        targetDeviceId: deviceId,
        mode: input.mode,
        sessionId: input.sessionId,
        content: input.content,
      } satisfies AgentRunStartInput);
      return { streamId };
    },

    async interrupt(streamId, sessionId) {
      if (!streamId) {
        console.warn(
          "远程会话当前无可用 streamId，无法中断（可能是刷新/直接进入一个仍在跑的远程会话）",
        );
        return;
      }
      control({
        streamId,
        targetDeviceId: deviceId,
        sessionId,
        kind: "interrupt",
      });
    },

    async confirm(streamId, sessionId, toolCallId, decision, content) {
      if (!streamId) {
        throw new Error("远程会话 streamId 未就绪，请稍候重试");
      }
      control({
        streamId,
        targetDeviceId: deviceId,
        sessionId,
        kind: "confirm",
        toolCallId,
        decision,
        content,
      });
    },

    async answer(streamId, sessionId, toolCallId, answers) {
      if (!streamId) {
        throw new Error("远程会话 streamId 未就绪，请稍候重试");
      }
      control({
        streamId,
        targetDeviceId: deviceId,
        sessionId,
        kind: "answer",
        toolCallId,
        answers,
      });
    },

    async patchSessionModel(sessionId, modelConfigId) {
      await query("patch-session-model", { sessionId, modelConfigId });
    },

    async fetchPending(_sessionId): Promise<PendingResponse> {
      // 远程 relay 无「排队未处理」语义（同 web-agent 远程工厂）——
      // use-session-stream 只在 local 分支调用本方法，如实抛错而非伪造空结果。
      throw new Error(
        "远程会话不支持 pending 查询（SessionTransport.fetchPending 仅本地会话适用）",
      );
    },

    async fetchActiveRun(_sessionId) {
      // 契约偏差（见任务报告 concerns）：web-agent 的远程实现能查到 streamId
      // reclaim，是因为 A 侧有一个常驻的 server-agent 进程，用 REST 端点查询它
      // 本地维护的 (targetDeviceId, sessionId) → streamId 内存表
      // （`RemoteRunService.findRunBySession`）。web-main 的浏览器连接是
      // L3 协议里真正的「A」，没有这样一层常驻进程可查——L3 协议本身
      // （`DeviceQueryKindSchema`）也没有提供按 sessionId 反查 streamId 的
      // query kind，`im.gateway.ts` 的 `agentRunRoutes` 只能按 streamId 正向查，
      // 无 sessionId 反向索引。刷新页面 / 直接进入一个仍在跑的远程会话时无法
      // reclaim，如实抛错而非伪造 null（伪造 null 会让调用方误以为「查过了，
      // 确实没有活跃 run」，而不是「这个能力压根不存在」）。
      throw new Error(
        "web-main 远程会话暂不支持 streamId reclaim（L3 协议未提供按 sessionId 反查 streamId 的通道）",
      );
    },

    async readArtifact(sessionId, path) {
      return (await query("artifact-file", {
        sessionId,
        filePath: path,
      })) as
        | { kind: "content"; name: string; base64: string }
        | { kind: "too-large"; name: string; size: number };
    },

    async uploadArtifactToDrive(sessionId, path) {
      return (await query("artifact-upload-drive", {
        sessionId,
        filePath: path,
      })) as { fileId: string; name: string };
    },

    subscribe(events) {
      return runEvents.subscribe(events);
    },

    dispose() {
      // run 帧监听器挂在 module 级单例 socket（`getImSocket()`）上，不随 transport
      // 实例 GC 自动摘除——组件 unmount 时必须显式 off，否则每次 remount（导航切换
      // 会话/设备）都会累积一份，重复触发 `runs.handleFrame`。deviceQueryResponse
      // 监听器归 device-query.ts 单例常驻，不在此摘除。
      socket.off(IM_WS_EVENTS.agentRunFrame, onRunFrame);
      socket.off(IM_WS_EVENTS.agentRunEnd, onRunEnd);
      runs.reset();
      runEvents.reset();
    },
  };
}
