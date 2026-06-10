import { Global, Module } from "@nestjs/common";

import { type AppConfig, APP_CONFIG } from "./app-config.schema";

/**
 * 全局配置模块。持有 loadAppConfig 产出的强类型 AppConfig，
 * 通过 APP_CONFIG token 注入各模块。
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS DynamicModule 模式要求 class + 静态 forRoot
export class AppConfigModule {
  static forRoot(config: AppConfig) {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
