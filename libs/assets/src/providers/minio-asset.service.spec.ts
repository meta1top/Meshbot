import { Readable } from "node:stream";

const mockClient = {
  bucketExists: jest.fn(),
  makeBucket: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  removeObject: jest.fn(),
  statObject: jest.fn(),
  presignedGetObject: jest.fn(),
  presignedPutObject: jest.fn(),
};
jest.mock("minio", () => ({
  Client: jest.fn(() => mockClient),
}));

import { MinioAssetService } from "./minio-asset.service";

const CFG = {
  endPoint: "localhost",
  port: 9000,
  useSSL: false,
  accessKey: "ak",
  secretKey: "sk",
  bucket: "meshbot",
};

describe("MinioAssetService", () => {
  let svc: MinioAssetService;
  beforeEach(() => {
    for (const fn of Object.values(mockClient)) fn.mockReset();
    svc = new MinioAssetService(CFG);
  });

  it("put 调 putObject(bucket,key,buf,size,Content-Type)", async () => {
    mockClient.putObject.mockResolvedValue({ etag: "x" });
    const buf = Buffer.from("hello");
    await svc.put("skills/a/1.0.0.tar.gz", buf, "application/gzip");
    expect(mockClient.putObject).toHaveBeenCalledWith(
      "meshbot",
      "skills/a/1.0.0.tar.gz",
      buf,
      buf.length,
      { "Content-Type": "application/gzip" },
    );
  });

  it("get 把 getObject 流聚合为 Buffer", async () => {
    mockClient.getObject.mockResolvedValue(
      Readable.from([Buffer.from("ab"), Buffer.from("c")]),
    );
    const out = await svc.get("k");
    expect(out.toString()).toBe("abc");
    expect(mockClient.getObject).toHaveBeenCalledWith("meshbot", "k");
  });

  it("getStream 直接返回 getObject 流", async () => {
    const stream = Readable.from([Buffer.from("x")]);
    mockClient.getObject.mockResolvedValue(stream);
    expect(await svc.getStream("k")).toBe(stream);
  });

  it("delete 调 removeObject", async () => {
    mockClient.removeObject.mockResolvedValue(undefined);
    await svc.delete("k");
    expect(mockClient.removeObject).toHaveBeenCalledWith("meshbot", "k");
  });

  it("exists：statObject 成功→true", async () => {
    mockClient.statObject.mockResolvedValue({ size: 3 });
    expect(await svc.exists("k")).toBe(true);
  });

  it("exists：statObject 抛错→false", async () => {
    mockClient.statObject.mockRejectedValue(new Error("NotFound"));
    expect(await svc.exists("k")).toBe(false);
  });

  it("getSignedUrl 调 presignedGetObject(bucket,key,ttl)", async () => {
    mockClient.presignedGetObject.mockResolvedValue("http://signed");
    expect(await svc.getSignedUrl("k", 600)).toBe("http://signed");
    expect(mockClient.presignedGetObject).toHaveBeenCalledWith(
      "meshbot",
      "k",
      600,
    );
  });

  it("ensureBucket：不存在则 makeBucket", async () => {
    mockClient.bucketExists.mockResolvedValue(false);
    mockClient.makeBucket.mockResolvedValue(undefined);
    await svc.ensureBucket();
    expect(mockClient.makeBucket).toHaveBeenCalledWith("meshbot");
  });

  it("ensureBucket：已存在则不 makeBucket", async () => {
    mockClient.bucketExists.mockResolvedValue(true);
    await svc.ensureBucket();
    expect(mockClient.makeBucket).not.toHaveBeenCalled();
  });

  it("getUploadUrl 调 presignedPutObject(bucket,key,ttl) 返回 URL", async () => {
    mockClient.presignedPutObject.mockResolvedValue("http://minio/put-url");
    const url = await svc.getUploadUrl("drive/o1/n1", 600);
    expect(mockClient.presignedPutObject).toHaveBeenCalledWith(
      "meshbot",
      "drive/o1/n1",
      600,
    );
    expect(url).toBe("http://minio/put-url");
  });

  it("stat 调 statObject(bucket,key) 返回 size", async () => {
    mockClient.statObject.mockResolvedValue({
      size: 1234,
      contentType: "application/octet-stream",
    });
    const res = await svc.stat("drive/o1/n1");
    expect(mockClient.statObject).toHaveBeenCalledWith(
      "meshbot",
      "drive/o1/n1",
    );
    expect(res).toEqual({ size: 1234 });
  });
});
