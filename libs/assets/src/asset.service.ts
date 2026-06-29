import type { AssetStat, SignedUrlOptions } from "./asset.types";

/**
 * 对象存储服务（抽象类兼 NestJS DI token）。消费方注入 `AssetService`，
 * 具体实现由 AssetsModule.forRoot 按配置绑定（本期 MinioAssetService）。
 * key 由调用方给定（如 `skills/<slug>/<version>.tar.gz`），本服务不拼 key。
 */
export abstract class AssetService {
  /** 写入对象（覆盖同 key）。 */
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** 读对象为完整 Buffer。 */
  abstract get(key: string): Promise<Buffer>;
  /** 读对象为可读流（大文件/转发用）。 */
  abstract getStream(key: string): Promise<NodeJS.ReadableStream>;
  /** 删除对象（不存在不报错）。 */
  abstract delete(key: string): Promise<void>;
  /** 对象是否存在。 */
  abstract exists(key: string): Promise<boolean>;
  /** 取临时下载签名 URL。opts 可覆盖响应 Content-Type / Content-Disposition，使浏览器正确预览并带文件名。 */
  abstract getSignedUrl(
    key: string,
    ttlSeconds: number,
    opts?: SignedUrlOptions,
  ): Promise<string>;
  /** 取临时上传（PUT）签名 URL —— 客户端直传 Minio 用。 */
  abstract getUploadUrl(key: string, ttlSeconds: number): Promise<string>;
  /** 取对象元信息（size 等）。 */
  abstract stat(key: string): Promise<AssetStat>;
  /** 确保 bucket 存在（模块初始化时调）。 */
  abstract ensureBucket(): Promise<void>;
}

// AssetStat / SignedUrlOptions 已从 asset.types 导出，此处仅引用供子类使用
export type { AssetStat, SignedUrlOptions };
