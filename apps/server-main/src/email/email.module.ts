import { Module } from "@nestjs/common";

import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";
import {
  DirectMailEmailSender,
  EMAIL_SENDER,
  LogEmailSender,
} from "./email-sender";

/**
 * 邮件模块。按 config.email 是否存在选择 DirectMail / Log 实现。
 * 通过 EMAIL_SENDER token 暴露给邀请流程。
 */
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.email
          ? new DirectMailEmailSender(config.email)
          : new LogEmailSender(),
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
