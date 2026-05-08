import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { LocalAuthController } from "./local-auth.controller";
import { LocalAuthService } from "./local-auth.service";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [PassportModule.register({ defaultStrategy: "jwt" })],
  controllers: [LocalAuthController],
  providers: [LocalAuthService, JwtStrategy],
  exports: [LocalAuthService],
})
export class LocalAuthModule {}
