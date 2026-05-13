import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { CommonModule } from "../src/common.module";
import { Cacheable, CacheEvict } from "../src/decorators";

@Injectable()
class ProfileService {
  public hits = 0;

  @Cacheable({ key: "profile:#{0}", ttl: 60_000 })
  async getProfile(userId: string): Promise<{ id: string }> {
    this.hits++;
    return { id: userId };
  }

  @CacheEvict({ key: "profile:#{0}" })
  async updateProfile(userId: string, _data: object): Promise<void> {}
}

describe("@Cacheable / @CacheEvict", () => {
  let svc: ProfileService;
  beforeEach(async () => {
    const ref = await Test.createTestingModule({
      imports: [CommonModule.forRoot()],
      providers: [ProfileService],
    }).compile();
    await ref.init();
    svc = ref.get(ProfileService);
  });

  it("第一次未命中，第二次命中", async () => {
    await svc.getProfile("u1");
    await svc.getProfile("u1");
    expect(svc.hits).toBe(1);
  });

  it("CacheEvict 后再次访问需要重算", async () => {
    await svc.getProfile("u1");
    await svc.updateProfile("u1", {});
    await svc.getProfile("u1");
    expect(svc.hits).toBe(2);
  });
});
