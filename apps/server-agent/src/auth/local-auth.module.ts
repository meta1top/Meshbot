import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "./jwt.strategy";
import { LocalAuthController } from "./local-auth.controller";
import { LocalAuthService } from "./local-auth.service";

@Module({
  imports: [PassportModule.register({ defaultStrategy: "jwt" })],
  controllers: [LocalAuthController],
  providers: [LocalAuthService, JwtStrategy],
  exports: [LocalAuthService],
})
export class LocalAuthModule {}
