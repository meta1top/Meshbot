import { Controller, Post, Body, Get } from "@nestjs/common";
import { LocalAuthService } from "./local-auth.service";
import { RegisterDto, LoginDto } from "@anybot/types-agent";

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
