import { DRIVE_PORT, MeshbotConfigModule } from "@meshbot/agent";
import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { DriveToolService } from "./services/drive-tool.service";

/**
 * @Global DriveToolModule：绑定 DRIVE_PORT → DriveToolService，
 * 供 libs/agent 中 5 个网盘工具（DriveListTool / DriveMkdirTool /
 * DriveUploadTool / DriveDownloadTool / DriveShareTool）注入。
 *
 * DriveGatewayService 通过 AuthModule（已 export）注入；
 * MeshbotConfigService 通过 MeshbotConfigModule 显式注入。
 */
@Global()
@Module({
  imports: [AuthModule, MeshbotConfigModule],
  providers: [
    DriveToolService,
    { provide: DRIVE_PORT, useExisting: DriveToolService },
  ],
  exports: [DriveToolService, DRIVE_PORT],
})
export class DriveToolModule {}
