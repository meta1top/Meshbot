import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { LoginDto, RegisterDto } from "../dto/auth.dto";
import { Public } from "../guards/jwt-auth.guard";
import { AuthService } from "../services/auth.service";

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.username, dto.password);
  }

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.username, dto.password);
  }

  @Public()
  @Get("status")
  getStatus() {
    return this.authService.getStatus();
  }

  /** 取当前登录用户 profile（受 JWT 保护，未登录返回 401）。 */
  @Get("profile")
  profile(@Req() req: { user?: { id: string; username: string } }) {
    return this.authService.getProfile(req.user?.id ?? "");
  }
}
