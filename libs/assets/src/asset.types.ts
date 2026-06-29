/** minio 连接配置（由调用方从 env 读好后传入 AssetsModule.forRoot）。 */
export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/** 资产存储配置。本期仅 minio；s3/oss 以后扩 provider 联合类型。 */
export interface AssetsConfig {
  provider: "minio";
  minio: MinioConfig;
}

/** 对象元信息。 */
export interface AssetStat {
  size: number;
  contentType?: string;
}

/** 下载签名 URL 的响应头覆盖：让浏览器正确预览（而非按 octet-stream 下载）并带上文件名。 */
export interface SignedUrlOptions {
  /** 覆盖响应 Content-Type，使浏览器/iframe 正确识别类型并内联预览。 */
  contentType?: string;
  /** 文件名，用于 Content-Disposition 的 filename（支持中文）。 */
  fileName?: string;
  /** inline=内联预览（默认）/ attachment=强制下载。 */
  disposition?: "inline" | "attachment";
}
