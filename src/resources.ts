import { InvalidDependencyError } from './errors.ts';
import { isFunction, isObject } from './utils.ts';

/** 按首次成功创建的顺序登记实例所有权，同一对象只释放一次。 */
export class ResourceStore {
  #values = new Map<object, 'owned' | 'borrowed'>();

  add(value: unknown, ownership: 'owned' | 'borrowed'): void {
    if (!isObject(value)) {
      return;
    }

    const previous = this.#values.get(value);

    if (previous && previous !== ownership) {
      throw new InvalidDependencyError('The same instance cannot be both owned and borrowed');
    }

    this.#values.set(value, ownership);
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];

    for (const [value, ownership] of [...this.#values].reverse()) {
      if (ownership === 'borrowed') {
        continue;
      }

      try {
        const method: unknown =
          Reflect.get(value, Symbol.asyncDispose) ?? Reflect.get(value, Symbol.dispose);

        if (isFunction(method)) {
          await Reflect.apply(method, value, []);
        }
      } catch (error) {
        errors.push(error);
      }
    }

    this.#values.clear();

    if (errors.length) {
      throw new AggregateError(errors, 'Failed to dispose Cyrene resources');
    }
  }
}
