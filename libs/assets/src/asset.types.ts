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
