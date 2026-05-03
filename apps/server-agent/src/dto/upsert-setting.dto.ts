import { IsNotEmpty, IsString } from "class-validator";

export class UpsertSettingDto {
  @IsString()
  @IsNotEmpty()
  value!: string;
}
