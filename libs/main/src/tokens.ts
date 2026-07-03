/**
 * libs/main DI 注入 token。
 *
 * B8（MainModule wiring）需提供：
 *   { provide: REDIS_CLIENT, useValue: <ioredis Redis instance | null> }
 */

/** ioredis 实例（或 null）的注入 token，供 PresenceService 使用。 */
export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

/** 加密配置（对称密钥）的注入 token，供 SecretCryptoService 使用。 */
export const SECURITY_CONFIG = Symbol("SECURITY_CONFIG");
