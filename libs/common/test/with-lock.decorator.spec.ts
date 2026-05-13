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
    expect(svc.log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
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
