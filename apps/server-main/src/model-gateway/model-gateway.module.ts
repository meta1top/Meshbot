import { type DynamicModule, Module } from "@nestjs/common";

import { ChatCompletionsController } from "./chat-completions.controller";
import { ModelGatewayService } from "./model-gateway.service";

/**
 * 云端模型网关 feature module：`POST /v1/chat/completions`。
 *
 * `ModelGatewayService` 依赖 `@meshbot/main` 的 `OrgModelConfigService`
 * （`MainModule.forRoot()` 导出）。`forRoot` 要求调用方传入 **`AppModule` 里
 * 已构造好的同一个** `MainModule` DynamicModule 对象（而非在此重新调用
 * `MainModule.forRoot(...)`）——NestJS 默认按对象引用（而非深比较配置值）做
 * 动态模块去重，重新调用会额外实例化一份 `OrgModelConfigService` /
 * `SecretCryptoService`，与 `AppModule` 里其他 controller 用的不是同一实例。
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS DynamicModule 模式要求 class + 静态 forRoot
export class ModelGatewayModule {
  static forRoot(mainModule: DynamicModule): DynamicModule {
    return {
      module: ModelGatewayModule,
      imports: [mainModule],
      controllers: [ChatCompletionsController],
      providers: [ModelGatewayService],
    };
  }
}
