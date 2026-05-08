import { Injectable, UnauthorizedException, ConflictException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import { User } from "./entities/user.entity";

const users: User[] = [];
let nextId = 1;

const JWT_SECRET = process.env.ANYBOT_JWT_SECRET ?? "anybot-default-secret-change-in-prod";

@Injectable()
export class LocalAuthService {
  async register(username: string, password: string): Promise<{ user: Omit<User, "passwordHash"> }> {
    const existing = users.find((u) => u.username === username);
    if (existing) {
      throw new ConflictException("Username already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user: User = {
      id: nextId++,
      username,
      passwordHash,
      createdAt: new Date(),
    };
    users.push(user);

    const { passwordHash: _, ...safeUser } = user;
    return { user: safeUser };
  }

  async login(username: string, password: string): Promise<{ accessToken: string; user: Omit<User, "passwordHash"> }> {
    const user = users.find((u) => u.username === username);
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const { passwordHash: _, ...safeUser } = user;
    const accessToken = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: "7d",
    });

    return { accessToken, user: safeUser };
  }

  async validateUser(userId: number): Promise<Omit<User, "passwordHash"> | null> {
    const user = users.find((u) => u.id === userId);
    if (!user) return null;
    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  getUserCount(): number {
    return users.length;
  }
}
