import { Cyrene, formatGraph, ripple } from 'cyrenejs';

const write = (message: string) => process.stdout.write(`${message}\n`);
const Config = ripple('config', () => ({ databaseUrl: 'memory://demo', prefix: 'app' }));

const Logger = ripple('logger', { config: Config }, ({ config }) => ({
  info: (message: string) => write(`[${config.prefix}] ${message}`),
}));

const Database = ripple('database', { config: Config, logger: Logger }, ({ config, logger }) => {
  logger.info(`创建 Database: ${config.databaseUrl}`);

  return {
    url: config.databaseUrl,
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
    products: [
      { id: 1, name: 'Keyboard' },
      { id: 2, name: 'Mouse' },
    ],
    orders: [
      { userId: 1, productId: 1 },
      { userId: 2, productId: 2 },
    ],
    async [Symbol.asyncDispose]() {
      logger.info('释放 Database');
    },
  };
});

const Cache = ripple('cache', { logger: Logger }, ({ logger }) => {
  const entries = new Map<string, string>();
  logger.info('创建 Cache');

  return {
    remember(key: string, load: () => string) {
      const cached = entries.get(key);

      if (cached !== undefined) {
        logger.info(`命中缓存: ${key}`);

        return cached;
      }

      const value = load();
      entries.set(key, value);

      return value;
    },
    [Symbol.dispose]() {
      logger.info(`释放 Cache: ${entries.size} 条记录`);
      entries.clear();
    },
  };
});

// Users 和 Catalog 共享 Database、Cache 与 Logger, 形成多条菱形依赖路径。
const Users = ripple(
  'users',
  { database: Database, cache: Cache, logger: Logger },
  ({ database, cache, logger }) => {
    logger.info('创建 Users');

    return {
      list: () => database.users.map(user => user.name),
      name: (id: number) =>
        cache.remember(
          `user:${id}`,
          () => database.users.find(user => user.id === id)?.name ?? 'Unknown user',
        ),
      [Symbol.dispose]() {
        logger.info(`释放 Users, 数据库仍可访问: ${database.url}`);
      },
    };
  },
);

const Catalog = ripple(
  'catalog',
  { database: Database, cache: Cache, logger: Logger },
  ({ database, cache, logger }) => {
    logger.info('创建 Catalog');

    return {
      name: (id: number) =>
        cache.remember(
          `product:${id}`,
          () => database.products.find(product => product.id === id)?.name ?? 'Unknown product',
        ),
      [Symbol.dispose]() {
        logger.info(`释放 Catalog, 数据库仍可访问: ${database.url}`);
      },
    };
  },
);

const Orders = ripple(
  'orders',
  { database: Database, users: Users, catalog: Catalog, logger: Logger },
  ({ database, users, catalog, logger }) => {
    logger.info('创建 Orders');

    return {
      list: () =>
        database.orders.map(
          order => `${users.name(order.userId)} -> ${catalog.name(order.productId)}`,
        ),
      [Symbol.dispose]() {
        logger.info(`释放 Orders, Users 仍可访问: ${users.list().join(', ')}`);
      },
    };
  },
);

const Dashboard = ripple(
  'dashboard',
  { users: Users, orders: Orders, logger: Logger },
  ({ users, orders, logger }) => {
    logger.info('创建 Dashboard');

    return {
      render() {
        logger.info(`用户: ${users.list().join(', ')}`);
        logger.info(`订单: ${orders.list().join('; ')}`);
      },
      [Symbol.dispose]() {
        logger.info('释放 Dashboard');
      },
    };
  },
);

export async function runBasic(): Promise<void> {
  await using app = new Cyrene().use(Dashboard);

  app.override(
    Config,
    ripple('demoConfig', () => ({ databaseUrl: 'memory://configured', prefix: 'demo' })),
  );

  // 以业务入口为根展示多层关系, inspect 和 formatGraph 不会创建服务。
  write(formatGraph(app.inspect()));
  const dashboard = app.ripples.dashboard;
  dashboard.render();
  write('再次渲染, 复用同一组服务与缓存:');
  dashboard.render();
}
