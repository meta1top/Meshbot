import { Body, Controller, Get, Post } from "@nestjs/common";
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
}
