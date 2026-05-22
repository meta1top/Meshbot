import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { AgentErrorCode } from "../errors/agent.error-codes";

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

  async register(
    username: string,
    password: string,
  ): Promise<{ access_token: string }> {
    const existingUser = await this.userRepo.count();
    if (existingUser > 0) {
      throw new AppError(AgentErrorCode.AUTH_ALREADY_REGISTERED);
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
      throw new AppError(AgentErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new AppError(AgentErrorCode.AUTH_INVALID_CREDENTIALS);
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

  /**
   * 取当前用户 profile。userId 来自已验证的 JWT。
   *
   * 查库确认用户仍存在；不存在则抛未授权错误（JWT 有效但用户被删的防御分支）。
   */
  async getProfile(userId: string): Promise<{ id: string; username: string }> {
    const user = await this.validateUser(userId);
    if (!user) {
      // 防御性分支：JWT 有效但用户已被删，复用登录失败码
      throw new AppError(AgentErrorCode.AUTH_INVALID_CREDENTIALS);
    }
    return { id: user.id, username: user.username };
  }

  private signToken(user: User): { access_token: string } {
    const payload = { sub: user.id, username: user.username };
    return { access_token: this.jwtService.sign(payload) };
  }
}
