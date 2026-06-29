import { AccountContextService } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { CloudClientService } from "./cloud/cloud-client.service";
import { ImRelayClientService } from "./cloud/im-relay-client.service";
import { AuthController } from "./controllers/auth.controller";
import { CloudOrgController } from "./controllers/cloud-org.controller";
import { DriveController } from "./controllers/drive.controller";
import { CloudIdentity } from "./entities/cloud-identity.entity";
import { CloudAuthService } from "./services/cloud-auth.service";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { CloudOrgService } from "./services/cloud-org.service";
import { DriveGatewayService } from "./services/drive-gateway.service";
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
  controllers: [AuthController, CloudOrgController, DriveController],
  providers: [
    CloudIdentityService,
    CloudAuthService,
    CloudOrgService,
    DriveGatewayService,
    JwtStrategy,
    {
      provide: CloudClientService,
      inject: [ConfigService, CloudIdentityService, AccountContextService],
      useFactory: (
        config: ConfigService,
        identity: CloudIdentityService,
        account: AccountContextService,
      ) => {
        const client = new CloudClientService(config);
        // 云端 401（token 失效）→ 标记当前账号已登出 → setup-status 落回 needs-login。
        // 401 发生在请求的账号上下文内；无上下文（后台路径）时跳过。
        client.setUnauthorizedHandler(() => {
          const id = account.get();
          if (id) void identity.setLoggedOut(id);
        });
        return client;
      },
    },
    {
      provide: ImRelayClientService,
      inject: [
        ConfigService,
        CloudIdentityService,
        EventEmitter2,
        AccountContextService,
      ],
      useFactory: (
        config: ConfigService,
        identity: CloudIdentityService,
        emitter: EventEmitter2,
        account: AccountContextService,
      ) => new ImRelayClientService(identity, emitter, config, account),
    },
  ],
  exports: [
    CloudIdentityService,
    CloudAuthService,
    CloudClientService,
    ImRelayClientService,
    DriveGatewayService,
    JwtModule,
  ],
})
export class AuthModule {}
