import { LoginDto, RegisterDto } from "@meshbot/types-agent";
import { Body, Controller, Get, Post } from "@nestjs/common";
import { LocalAuthService } from "./local-auth.service";

@Controller("api/auth")
export class LocalAuthController {
  constructor(private authService: LocalAuthService) {}

  @Get("setup-status")
  getSetupStatus() {
    return { initialized: this.authService.getUserCount() > 0 };
  }

  @Post("register")
  async register(@Body() dto: RegisterDto) {
    if (this.authService.getUserCount() > 0) {
      return { error: "Registration closed. Admin already exists." };
    }
    return this.authService.register(dto.username, dto.password);
  }

  @Post("login")
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.username, dto.password);
  }
}
