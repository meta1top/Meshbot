import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from "class-validator";

export class CreateModelConfigDto {
  @IsString()
  @IsNotEmpty()
  providerType!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsString()
  @IsNotEmpty()
  apiKey!: string;

  @IsString()
  @IsOptional()
  baseUrl?: string;

  /** 用户显式覆盖的上下文窗口；不传则后端按 model 查 MODEL_SPECS 自动解析。 */
  @IsInt()
  @IsPositive()
  @IsOptional()
  contextWindow?: number;
}

export class UpdateModelConfigDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  model?: string;

  @IsString()
  @IsOptional()
  apiKey?: string;

  @IsString()
  @IsOptional()
  baseUrl?: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  /**
   * 显式覆盖 contextWindow；传 0 / 不传时，若同时 model 名变了，按新 model
   * 重新解析；model 没变则保留原值。
   */
  @IsInt()
  @IsPositive()
  @IsOptional()
  contextWindow?: number;
}
