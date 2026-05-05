import { IsBoolean, IsNotEmpty, IsOptional, IsString } from "class-validator";

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
}
