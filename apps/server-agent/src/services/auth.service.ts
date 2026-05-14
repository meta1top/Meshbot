import { Transactional } from "@meshbot/common";
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { I18nService } from "nestjs-i18n";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly i18n: I18nService,
  ) {}

  @Transactional()
  async register(
    username: string,
    password: string,
  ): Promise<{ access_token: string }> {
    const existingUser = await this.userRepo.count();
    if (existingUser > 0) {
      throw new ConflictException(
        this.i18n.translate("auth.alreadyRegistered"),
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = this.userRepo.create({ username, passwordHash });
    await this.userRepo.save(user);

    return this.signToken(user);
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ access_token: string }> {
    const user = await this.userRepo.findOneBy({ username });
    if (!user) {
      throw new UnauthorizedException(
        this.i18n.translate("auth.invalidCredentials"),
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException(
        this.i18n.translate("auth.invalidCredentials"),
      );
    }

    return this.signToken(user);
  }

  async getStatus(): Promise<{ initialized: boolean; needsSetup: boolean }> {
    const userCount = await this.userRepo.count();
    return {
      initialized: userCount > 0,
      needsSetup: userCount === 0,
    };
  }

  async validateUser(userId: string): Promise<User | null> {
    return this.userRepo.findOneBy({ id: userId });
  }

  private signToken(user: User): { access_token: string } {
    const payload = { sub: user.id, username: user.username };
    return { access_token: this.jwtService.sign(payload) };
  }
}
