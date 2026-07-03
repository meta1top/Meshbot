import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { type AppConfig, APP_CONFIG } from "../src/config/app-config.schema";
import { MetaController } from "../src/rest/meta.controller";

const TEST_APP_CONFIG = {
  webMainBase: "http://localhost:3002",
} as AppConfig;

describe("MetaController 路由编排", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetaController],
      providers: [{ provide: APP_CONFIG, useValue: TEST_APP_CONFIG }],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /meta → 回显 config.webMainBase", async () => {
    const res = await request(app.getHttpServer()).get("/meta").expect(200);

    expect(res.body).toEqual({ webMainBase: "http://localhost:3002" });
  });
});
