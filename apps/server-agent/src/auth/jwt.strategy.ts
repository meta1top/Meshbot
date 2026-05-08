import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { LocalAuthService } from "./local-auth.service";

const JWT_SECRET = process.env.ANYBOT_JWT_SECRET ?? "anybot-default-secret-change-in-prod";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: LocalAuthService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET,
    });
  }

  async validate(payload: { sub: number; username: string }) {
    const user = await this.authService.validateUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
