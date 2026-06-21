const mockClient = {
  bucketExists: jest.fn().mockResolvedValue(true),
  makeBucket: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  removeObject: jest.fn(),
  statObject: jest.fn(),
  presignedGetObject: jest.fn(),
};
jest.mock("minio", () => ({ Client: jest.fn(() => mockClient) }));

import { Test } from "@nestjs/testing";
import { AssetService } from "./asset.service";
import { AssetsModule } from "./assets.module";

const CFG = {
  provider: "minio" as const,
  minio: {
    endPoint: "localhost",
    port: 9000,
    useSSL: false,
    accessKey: "ak",
    secretKey: "sk",
    bucket: "meshbot",
  },
};

describe("AssetsModule.forRoot", () => {
  beforeEach(() => {
    for (const fn of Object.values(mockClient)) fn.mockReset();
    mockClient.bucketExists.mockResolvedValue(true);
  });

  it("解析出 AssetService 实例且可用", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AssetsModule.forRoot(CFG)],
    }).compile();
    const svc = moduleRef.get(AssetService);
    expect(svc).toBeInstanceOf(AssetService);
    mockClient.statObject.mockResolvedValue({ size: 1 });
    expect(await svc.exists("k")).toBe(true);
  });

  it("init() 时调 ensureBucket（bucket 不存在则建）", async () => {
    mockClient.bucketExists.mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      imports: [AssetsModule.forRoot(CFG)],
    }).compile();
    await moduleRef.init();
    expect(mockClient.makeBucket).toHaveBeenCalledWith("meshbot");
  });
});
