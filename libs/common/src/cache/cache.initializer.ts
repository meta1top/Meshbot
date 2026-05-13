import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
// biome-ignore lint/style/useImportType: DiscoveryService 必须为值导入，否则 NestJS 构造器 DI 在运行时取不到类引用
import { DiscoveryService } from "@nestjs/core";

import {
  CACHEABLE_MARKER,
  injectCacheProvider,
} from "../decorators/cacheable.decorator";
import { CACHE_PROVIDER, type CacheProvider } from "./cache.provider";

@Injectable()
export class CacheInitializer implements OnModuleInit {
  private readonly logger = new Logger(CacheInitializer.name);

  constructor(
    @Inject(CACHE_PROVIDER) private readonly cache: CacheProvider,
    private readonly discoveryService: DiscoveryService,
  ) {}

  onModuleInit() {
    const providers = this.discoveryService.getProviders();
    let count = 0;
    providers.forEach((wrapper) => {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") return;
      if (Reflect.getMetadata(CACHEABLE_MARKER, instance.constructor)) {
        injectCacheProvider(instance, this.cache);
        count++;
      }
    });
    if (count > 0)
      this.logger.log(`Initialized cache provider for ${count} services`);
  }
}
