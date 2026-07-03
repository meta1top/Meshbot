import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { CommonModule } from "../src/common.module";
import { WithLock } from "../src/decorators";

@Injectable()
class CounterService {
  public log: string[] = [];

  @WithLock({ key: "counter:#{0}", waitTimeout: 1000 })
  async run(id: string, label: string): Promise<void> {
    this.log.push(`${label}-start`);
    await new Promise((r) => setTimeout(r, 30));
    this.log.push(`${label}-end`);
  }
}

describe("@WithLock with MemoryLockProvider", () => {
  let svc: CounterService;

  beforeEach(async () => {
    const ref = await Test.createTestingModule({
      imports: [CommonModule.forRoot()],
      providers: [CounterService],
    }).compile();
    await ref.init();
    svc = ref.get(CounterService);
  });

  it("同一 key 串行化", async () => {
    await Promise.all([svc.run("X", "a"), svc.run("X", "b")]);
    // 串行化语义 = 两次调用不交错；但 Promise.all 不保证「数组首元素先拿到锁」
    // （并发获锁的调度序不定，CI 负载下尤其），故不能硬编码 a 先。断言无交错：
    // 先跑者整段 start→end 跑完，后跑者才开始。
    expect(svc.log).toHaveLength(4);
    const firstLabel = svc.log[0].split("-")[0];
    const secondLabel = firstLabel === "a" ? "b" : "a";
    expect(svc.log).toEqual([
      `${firstLabel}-start`,
      `${firstLabel}-end`,
      `${secondLabel}-start`,
      `${secondLabel}-end`,
    ]);
  });

  it("不同 key 并发", async () => {
    await Promise.all([svc.run("X", "a"), svc.run("Y", "b")]);
    // 两个 key 不同，交错执行；排序后必须都包含 4 个标记
    expect(svc.log.slice().sort()).toEqual([
      "a-end",
      "a-start",
      "b-end",
      "b-start",
    ]);
  });
});
