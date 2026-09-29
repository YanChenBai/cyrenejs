import { Cyrene, type Dependency, type EntryDeclarations, type ResolveEntries } from 'cyrenejs';
import { Elysia } from 'elysia';

let nextPluginId = 0;

/** 每个插件实例拥有一个容器；多个路由应复用同一插件实例。 */
export function ElysiaCyrene() {
  const cyrene = new Cyrene();

  return new Elysia({ name: '@cyrenejs/elysia', seed: nextPluginId++ })
    .decorate({ cyrene })
    .onStop(() => cyrene.dispose());
}

/** 在首次解析前注册入口；异步 Ripple 的属性值仍为 Promise。 */
export function useRipples<const TRipples extends readonly Dependency[]>(...ripples: TRipples) {
  return (app: Elysia) => {
    const cyrene = (app.decorator as Record<string, unknown>).cyrene;

    if (!(cyrene instanceof Cyrene)) {
      throw new Error('Register ElysiaCyrene() before useRipples()');
    }

    cyrene.use(...ripples);

    type Entries = ResolveEntries<EntryDeclarations<TRipples>>;

    // 不枚举入口，避免 Elysia 合并 decorator 时提前解析并锁定依赖图。
    const view = new Proxy(Object.freeze({}) as Entries, {
      get(_, key) {
        return Reflect.get(cyrene.ripples, key);
      },
      has(_, key) {
        return key in cyrene.ripples;
      },
    });

    return app.decorate({ ripples: view });
  };
}
