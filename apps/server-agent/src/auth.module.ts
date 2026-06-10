import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { CloudClientService } from "./cloud/cloud-client.service";
import { AuthController } from "./controllers/auth.controller";
import { CloudOrgController } from "./controllers/cloud-org.controller";
import { CloudIdentity } from "./entities/cloud-identity.entity";
import { CloudAuthService } from "./services/cloud-auth.service";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { CloudOrgService } from "./services/cloud-org.service";
import { JWT_SECRET, JwtStrategy } from "./strategies/jwt.strategy";

@Module({
  imports: [
    TxTypeOrmModule.forFeature([CloudIdentity]),
    PassportModule,
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: "7d" },
    }),
  ],
  controllers: [AuthController, CloudOrgController],
  providers: [
    CloudIdentityService,
    CloudAuthService,
    CloudOrgService,
    JwtStrategy,
    {
      provide: CloudClientService,
      inject: [ConfigService, CloudIdentityService],
      useFactory: (config: ConfigService, identity: CloudIdentityService) => {
        const client = new CloudClientService(config);
        // 云端 401（token 失效）→ 清本地身份 → setup-status 落回 needs-login
        client.setUnauthorizedHandler(() => identity.clear());
        return client;
      },
    },
  ],
  exports: [CloudIdentityService, CloudAuthService, JwtModule],
})
export class AuthModule {}
