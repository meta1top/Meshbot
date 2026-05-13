import { type DynamicModule, Module } from "@nestjs/common";
import { getDataSourceToken, getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, type EntitySchema, type EntityTarget, type ObjectLiteral, Repository } from "typeorm";

import { txStorage } from "./transaction-context";

// biome-ignore lint/complexity/noBannedTypes: matches @nestjs/typeorm's EntityClassOrSchema definition
type EntityClassOrSchema = Function | EntitySchema;

/**
 * 为 Repository 创建事务感知代理。
 *
 * 当 AsyncLocalStorage 中存在活跃的 QueryRunner 时，
 * 所有属性/方法访问自动委托到事务作用域的 Repository；
 * 否则使用原始 Repository。
 */
function createTxAwareProxy<T extends ObjectLiteral>(repo: Repository<T>): Repository<T> {
  return new Proxy(repo, {
    get(target, prop, _receiver) {
      const ctx = txStorage.getStore();
      const effective: Repository<T> = ctx
        ? ctx.queryRunner.manager.getRepository(target.target as EntityTarget<T>)
        : target;

      const value = Reflect.get(effective, prop, effective);
      if (typeof value === "function") {
        // biome-ignore lint/complexity/noBannedTypes: binding dynamic method from repository
        return (value as Function).bind(effective);
      }
      return value;
    },
  });
}

/**
 * 事务感知的 TypeORM Module —— 替代 `TypeOrmModule.forFeature()`。
 *
 * 提供的 Repository 与 `@InjectRepository(Entity)` 完全兼容，
 * 区别在于：当调用链上存在 `@Transactional()` 开启的事务时，
 * Repository 的所有操作自动在该事务内执行，无需子方法添加任何装饰器。
 */
@Module({})
export class TxTypeOrmModule {
  static forFeature(entities: EntityClassOrSchema[], dataSourceName?: string): DynamicModule {
    const providers = entities.map((entity) => ({
      provide: getRepositoryToken(entity, dataSourceName),
      inject: [getDataSourceToken(dataSourceName)],
      useFactory: (ds: DataSource) => {
        const baseRepo = ds.getRepository(entity);
        return createTxAwareProxy(baseRepo);
      },
    }));

    return {
      module: TxTypeOrmModule,
      imports: [TypeOrmModule.forFeature(entities, dataSourceName)],
      providers,
      exports: providers.map((p) => p.provide),
    };
  }
}
