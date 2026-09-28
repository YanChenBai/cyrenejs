import { InvalidDependencyError } from './errors.ts';
import { isFunction, isObject } from './utils.ts';

/** 弱引用记录所有权，仅保留待清理资源，并按首次完成顺序去重。 */
export class ResourceStore {
  #ownership = new WeakMap<object, 'owned' | 'borrowed'>();

  #disposables: object[] = [];

  add(value: unknown, ownership: 'owned' | 'borrowed'): void {
    if (!isObject(value)) {
      return;
    }

    const previous = this.#ownership.get(value);

    if (previous && previous !== ownership) {
      throw new InvalidDependencyError('The same instance cannot be both owned and borrowed');
    }

    if (previous) {
      return;
    }

    this.#ownership.set(value, ownership);

    // 仅检查协议是否存在，将 getter 求值和清理错误留到 dispose。
    if (ownership === 'owned' && (Symbol.asyncDispose in value || Symbol.dispose in value)) {
      this.#disposables.push(value);
    }
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];

    for (const value of [...this.#disposables].reverse()) {
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

    this.#disposables = [];
    this.#ownership = new WeakMap();

    if (errors.length) {
      throw new AggregateError(errors, 'Failed to dispose Cyrene resources');
    }
  }
}
