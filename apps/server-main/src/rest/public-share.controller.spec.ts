import { AppError } from "@meshbot/common";
import { CloudShareLinkService, ShareDownloadDto } from "@meshbot/main";
import { MainErrorCode } from "@meshbot/main";
import { Test, type TestingModule } from "@nestjs/testing";
import { PublicShareController } from "./public-share.controller";

const mockService = {
  resolveOrThrow: jest.fn(),
  verifyPassword: jest.fn(),
  signDownload: jest.fn(),
};

describe("PublicShareController", () => {
  let controller: PublicShareController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicShareController],
      providers: [{ provide: CloudShareLinkService, useValue: mockService }],
    }).compile();
    controller = module.get(PublicShareController);
  });

  describe("GET :token (info)", () => {
    it("有效 token 返回文件元信息（不含 nodeId/orgId）", async () => {
      const link = { passwordHash: null };
      const node = {
        name: "report.pdf",
        sizeBytes: BigInt(12345),
        mime: "application/pdf",
      };
      mockService.resolveOrThrow.mockResolvedValueOnce({ link, node });

      const result = await controller.info("abc123");

      expect(result).toEqual({
        name: "report.pdf",
        sizeBytes: 12345,
        mime: "application/pdf",
        requiresPassword: false,
      });
      // 确认不含内部 id
      expect(result).not.toHaveProperty("nodeId");
      expect(result).not.toHaveProperty("orgId");
      expect(result).not.toHaveProperty("createdByUserId");
    });

    it("有密码链接 requiresPassword=true", async () => {
      const link = { passwordHash: "$2b$12$somehash" };
      const node = {
        name: "secret.zip",
        sizeBytes: BigInt(9999),
        mime: "application/zip",
      };
      mockService.resolveOrThrow.mockResolvedValueOnce({ link, node });

      const result = await controller.info("tok123");
      expect(result.requiresPassword).toBe(true);
    });

    it("撤销 token → 抛 DRIVE_SHARE_NOT_FOUND", async () => {
      mockService.resolveOrThrow.mockRejectedValueOnce(
        new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND),
      );
      await expect(controller.info("revoked")).rejects.toMatchObject({
        errorCode: MainErrorCode.DRIVE_SHARE_NOT_FOUND,
      });
    });

    it("过期 token → 抛 DRIVE_SHARE_EXPIRED", async () => {
      mockService.resolveOrThrow.mockRejectedValueOnce(
        new AppError(MainErrorCode.DRIVE_SHARE_EXPIRED),
      );
      await expect(controller.info("expired")).rejects.toMatchObject({
        errorCode: MainErrorCode.DRIVE_SHARE_EXPIRED,
      });
    });
  });

  describe("POST :token/download", () => {
    const link = { passwordHash: null };
    const node = {
      name: "file.mp4",
      sizeBytes: BigInt(1000),
      mime: "video/mp4",
    };
    const presigned = {
      url: "https://s3.example.com/signed",
      name: "file.mp4",
      mime: "video/mp4",
    };

    it("无密码链接 → 返回 presigned url（无需传 password）", async () => {
      mockService.resolveOrThrow.mockResolvedValueOnce({ link, node });
      mockService.verifyPassword.mockResolvedValueOnce(true);
      mockService.signDownload.mockResolvedValueOnce(presigned);

      const dto = new ShareDownloadDto();
      const result = await controller.download("tok", dto);

      expect(result).toEqual(presigned);
      expect(mockService.verifyPassword).toHaveBeenCalledWith(link, undefined);
    });

    it("有密码链接密码正确 → 返回 presigned url", async () => {
      const linkWithPw = { passwordHash: "$2b$12$hash" };
      mockService.resolveOrThrow.mockResolvedValueOnce({
        link: linkWithPw,
        node,
      });
      mockService.verifyPassword.mockResolvedValueOnce(true);
      mockService.signDownload.mockResolvedValueOnce(presigned);

      const dto = new ShareDownloadDto();
      (dto as { password?: string }).password = "correctpw";
      const result = await controller.download("tok", dto);

      expect(result).toEqual(presigned);
      expect(mockService.verifyPassword).toHaveBeenCalledWith(
        linkWithPw,
        "correctpw",
      );
    });

    it("有密码链接缺密码 → 抛 DRIVE_SHARE_PASSWORD_INVALID", async () => {
      const linkWithPw = { passwordHash: "$2b$12$hash" };
      mockService.resolveOrThrow.mockResolvedValueOnce({
        link: linkWithPw,
        node,
      });
      mockService.verifyPassword.mockResolvedValueOnce(false);

      const dto = new ShareDownloadDto();
      await expect(controller.download("tok", dto)).rejects.toMatchObject({
        errorCode: MainErrorCode.DRIVE_SHARE_PASSWORD_INVALID,
      });
    });

    it("有密码链接密码错误 → 抛 DRIVE_SHARE_PASSWORD_INVALID", async () => {
      const linkWithPw = { passwordHash: "$2b$12$hash" };
      mockService.resolveOrThrow.mockResolvedValueOnce({
        link: linkWithPw,
        node,
      });
      mockService.verifyPassword.mockResolvedValueOnce(false);

      const dto = new ShareDownloadDto();
      (dto as { password?: string }).password = "wrongpw";
      await expect(controller.download("tok", dto)).rejects.toMatchObject({
        errorCode: MainErrorCode.DRIVE_SHARE_PASSWORD_INVALID,
      });
    });

    it("token 不存在/撤销 → resolveOrThrow 抛 DRIVE_SHARE_NOT_FOUND", async () => {
      mockService.resolveOrThrow.mockRejectedValueOnce(
        new AppError(MainErrorCode.DRIVE_SHARE_NOT_FOUND),
      );
      const dto = new ShareDownloadDto();
      await expect(controller.download("bad", dto)).rejects.toMatchObject({
        errorCode: MainErrorCode.DRIVE_SHARE_NOT_FOUND,
      });
    });
  });
});
