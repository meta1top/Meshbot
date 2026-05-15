import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** 标记 controller 方法或类为匿名可访问，跳过 JwtAuthGuard。 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
