import { AccountContextService } from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { CloudClientService } from "./cloud/cloud-client.service";
import { ImRelayClientService } from "./cloud/im-relay-client.service";
import { RemoteDeviceQueryService } from "./cloud/remote-device-query.service";
import { RemoteRunService } from "./cloud/remote-run.service";
import { AuthController } from "./controllers/auth.controller";
import { CloudOrgController } from "./controllers/cloud-org.controller";
import { DriveController } from "./controllers/drive.controller";
import { RemoteAgentSessionController } from "./controllers/remote-agent-session.controller";
import { CloudIdentity } from "./entities/cloud-identity.entity";
import { CloudAuthService } from "./services/cloud-auth.service";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { CloudMetaService } from "./services/cloud-meta.service";
import { CloudOrgService } from "./services/cloud-org.service";
import { buildUnauthorizedHandler } from "./services/cloud-unauthorized.handler";
import { DeviceAuthorizeService } from "./services/device-authorize.service";
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
  controllers: [
    AuthController,
    CloudOrgController,
    DriveController,
    RemoteAgentSessionController,
  ],
  providers: [
    CloudIdentityService,
    CloudAuthService,
    CloudMetaService,
    CloudOrgService,
    DeviceAuthorizeService,
    DriveGatewayService,
    JwtStrategy,
    RemoteDeviceQueryService,
    RemoteRunService,
    {
      provide: CloudClientService,
      inject: [
        ConfigService,
        CloudIdentityService,
        AccountContextService,
        EventEmitter2,
      ],
      useFactory: (
        config: ConfigService,
        identity: CloudIdentityService,
        account: AccountContextService,
        emitter: EventEmitter2,
      ) => {
        const client = new CloudClientService(config);
        // 云端 401（token 失效）→ 标记当前账号已登出 → setup-status 落回 needs-login，
        // 并发重授权事件（推 ws/events 提示前端）。handler 逻辑与单测见
        // services/cloud-unauthorized.handler.ts。
        client.setUnauthorizedHandler(
          buildUnauthorizedHandler(account, identity, emitter),
        );
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
    CloudOrgService,
    DriveGatewayService,
    JwtModule,
  ],
})
export class AuthModule {}
