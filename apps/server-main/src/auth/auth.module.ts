import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, type JwtModuleOptions } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { JwtMainStrategy } from "./jwt.strategy";

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): JwtModuleOptions => ({
        secret: cfg.getOrThrow<string>("JWT_SECRET"),
        signOptions: {
          expiresIn: (cfg.get<string>("JWT_EXPIRES") ?? "7d") as `${number}d`,
        },
      }),
    }),
  ],
  providers: [JwtMainStrategy],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
