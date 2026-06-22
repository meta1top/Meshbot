import {
  type DynamicModule,
  Logger,
  Module,
  type OnModuleInit,
} from "@nestjs/common";
import { AssetService } from "./asset.service";
import type { AssetsConfig } from "./asset.types";
import { MinioAssetService } from "./providers/minio-asset.service";

/**
 * 对象存储模块。`forRoot(config)` 按 provider 绑定 AssetService（本期仅 minio），
 * 模块初始化时确保 bucket 存在。消费方 import 后注入 `AssetService`。
 */
@Module({})
export class AssetsModule implements OnModuleInit {
  constructor(private readonly asset: AssetService) {}

  static forRoot(config: AssetsConfig): DynamicModule {
    return {
      module: AssetsModule,
      global: true,
      providers: [
        {
          provide: AssetService,
          useFactory: () => new MinioAssetService(config.minio),
        },
      ],
      exports: [AssetService],
    };
  }

  private readonly logger = new Logger(AssetsModule.name);

  /**
   * 启动时确保 bucket 存在；minio 不可达时仅告警不崩（符合「缺 minio 不影响启动，
   * 发布/下载运行期再报错」），避免对象存储抖动拖垮整个服务启动。
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.asset.ensureBucket();
    } catch (err) {
      this.logger.warn(
        `ensureBucket 失败（对象存储不可达？发布/下载将在运行期报错）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
