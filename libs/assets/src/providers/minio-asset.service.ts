import { Client } from "minio";
import { AssetService } from "../asset.service";
import type { AssetStat, MinioConfig, SignedUrlOptions } from "../asset.types";

/**
 * minio 实现。key 由调用方给定，全部操作落在 cfg.bucket。
 * 单测通过 jest.mock("minio") 注入假 Client，不连真实服务。
 */
export class MinioAssetService extends AssetService {
  private readonly client: Client;
  private readonly bucket: string;

  constructor(cfg: MinioConfig) {
    super();
    this.bucket = cfg.bucket;
    this.client = new Client({
      endPoint: cfg.endPoint,
      port: cfg.port,
      useSSL: cfg.useSSL,
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
    });
  }

  /** 写入对象（覆盖同 key）。 */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(this.bucket, key, body, body.length, {
      "Content-Type": contentType,
    });
  }

  /** 读对象为完整 Buffer。 */
  async get(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** 读对象为可读流（大文件/转发用）。 */
  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    return this.client.getObject(this.bucket, key);
  }

  /** 删除对象（不存在不报错）。 */
  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  /** 对象是否存在。 */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  /** 取临时下载签名 URL。opts 通过 S3 response-content-* 查询参数覆盖响应头，使浏览器正确预览并带文件名。 */
  async getSignedUrl(
    key: string,
    ttlSeconds: number,
    opts?: SignedUrlOptions,
  ): Promise<string> {
    const respHeaders: Record<string, string> = {};
    if (opts?.contentType) {
      respHeaders["response-content-type"] = opts.contentType;
    }
    if (opts?.fileName || opts?.disposition) {
      const disposition = opts.disposition ?? "inline";
      // filename*=UTF-8'' 支持中文/特殊字符文件名（RFC 5987）
      respHeaders["response-content-disposition"] = opts.fileName
        ? `${disposition}; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`
        : disposition;
    }
    if (Object.keys(respHeaders).length === 0) {
      return this.client.presignedGetObject(this.bucket, key, ttlSeconds);
    }
    return this.client.presignedGetObject(
      this.bucket,
      key,
      ttlSeconds,
      respHeaders,
    );
  }

  /** 取临时上传（PUT）签名 URL。 */
  async getUploadUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.client.presignedPutObject(this.bucket, key, ttlSeconds);
  }

  /** 取对象元信息（size）。 */
  async stat(key: string): Promise<AssetStat> {
    const s = await this.client.statObject(this.bucket, key);
    return { size: s.size };
  }

  /** 确保 bucket 存在（模块初始化时调）。 */
  async ensureBucket(): Promise<void> {
    const ok = await this.client.bucketExists(this.bucket);
    if (!ok) {
      await this.client.makeBucket(this.bucket);
    }
  }
}
