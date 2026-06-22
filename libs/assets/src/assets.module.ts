import { type DynamicModule, Module, type OnModuleInit } from "@nestjs/common";
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

  async onModuleInit(): Promise<void> {
    await this.asset.ensureBucket();
  }
}
