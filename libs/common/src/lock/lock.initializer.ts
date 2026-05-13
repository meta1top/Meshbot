import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { DiscoveryService } from "@nestjs/core";

import {
  injectLockProvider,
  WITH_LOCK_MARKER,
} from "../decorators/with-lock.decorator";
import { LOCK_PROVIDER, type LockProvider } from "./lock.provider";

@Injectable()
export class LockInitializer implements OnModuleInit {
  private readonly logger = new Logger(LockInitializer.name);

  constructor(
    @Inject(LOCK_PROVIDER) private readonly provider: LockProvider,
    private readonly discoveryService: DiscoveryService,
  ) {}

  onModuleInit() {
    const providers = this.discoveryService.getProviders();
    let count = 0;

    providers.forEach((wrapper) => {
      const { instance } = wrapper;
      if (!instance || typeof instance !== "object") return;

      const hasLock = Reflect.getMetadata(
        WITH_LOCK_MARKER,
        instance.constructor,
      );
      if (hasLock) {
        injectLockProvider(instance, this.provider);
        count++;
      }
    });

    if (count > 0) {
      this.logger.log(`Initialized lock provider for ${count} services`);
    }
  }
}
