import "reflect-metadata";
import { AgentModule } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { type INestApplication } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import request from "supertest";
import { SessionController } from "../../src/controllers/session.controller";
import { LlmCall } from "../../src/entities/llm-call.entity";
import { PendingMessage } from "../../src/entities/pending-message.entity";
import { Session } from "../../src/entities/session.entity";
import { SessionMessage } from "../../src/entities/session-message.entity";
import { CheckpointerCleanupService } from "../../src/services/checkpointer-cleanup.service";
import { LlmCallService } from "../../src/services/llm-call.service";
import { RunnerService } from "../../src/services/runner.service";
import { SessionMessageService } from "../../src/services/session-message.service";
import { SessionTitleService } from "../../src/services/session-title.service";
import { SessionService } from "../../src/services/session.service";

describe("Session e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [Session, PendingMessage, LlmCall, SessionMessage],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([
          Session,
          PendingMessage,
          LlmCall,
          SessionMessage,
        ]),
        AgentModule,
      ],
      controllers: [SessionController],
      providers: [
        SessionService,
        RunnerService,
        LlmCallService,
        SessionMessageService,
        CheckpointerCleanupService,
        SessionTitleService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/sessions 创建会话返回 sessionId", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "你好" })
      .expect(201);
    expect(typeof res.body.sessionId).toBe("string");
  });

  it("POST /api/sessions/:id/messages 追加消息", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "first" });
    const sessionId = created.body.sessionId as string;
    const res = await request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ content: "second" })
      .expect(201);
    expect(typeof res.body.messageId).toBe("string");
  });

  it("GET /api/sessions/:id/pending 返回排队消息", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "排队消息" });
    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${created.body.sessionId}/pending`)
      .expect(200);
    expect(Array.isArray(res.body.pending)).toBe(true);
  });

  it("GET /api/sessions/:id/history 返回 messages 与 inflight 字段", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "历史测试" });
    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${created.body.sessionId}/history`)
      .expect(200);
    expect(res.body).toHaveProperty("messages");
    expect(res.body).toHaveProperty("inflight");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("byMessage");
    expect(res.body.sessionTotals.callCount).toBe(0);
  });

  it("GET /api/sessions/:id/pending 对不存在的会话返回 404", async () => {
    await request(app.getHttpServer())
      .get("/api/sessions/nonexistent-id/pending")
      .expect(404);
  });

  it("POST /api/sessions/:id/retry 无 failed 消息返回 retried:false", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/sessions")
      .send({ content: "retry 测试" });
    const res = await request(app.getHttpServer())
      .post(`/api/sessions/${created.body.sessionId}/retry`)
      .expect(201);
    expect(res.body.retried).toBe(false);
  });
});
