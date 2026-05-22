import { TxTypeOrmModule } from "@meshbot/common";
import { type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import request from "supertest";
import { AuthController } from "../../src/controllers/auth.controller";
import { User } from "../../src/entities/user.entity";
import { JwtAuthGuard } from "../../src/guards/jwt-auth.guard";
import { AuthService } from "../../src/services/auth.service";
import { JWT_SECRET, JwtStrategy } from "../../src/strategies/jwt.strategy";

describe("Auth profile e2e", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "better-sqlite3",
          database: ":memory:",
          entities: [User],
          synchronize: true,
        }),
        TxTypeOrmModule.forFeature([User]),
        PassportModule,
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: "7d" },
        }),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const reg = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ username: "alice", password: "pw123456" });
    token = reg.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/auth/profile 无 token 返回 401", async () => {
    await request(app.getHttpServer()).get("/api/auth/profile").expect(401);
  });

  it("GET /api/auth/profile 有效 token 返回当前用户", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.username).toBe("alice");
    expect(typeof res.body.id).toBe("string");
  });
});
