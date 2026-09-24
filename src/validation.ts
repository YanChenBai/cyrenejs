import { POEM_BRAND } from './brands.ts';
import { assertResolvable } from './dependency.ts';
import { InvalidDependencyError } from './errors.ts';

function rippleKeys(value: object): PropertyKey[] {
  return Reflect.ownKeys(value).filter(key => {
    if (Array.isArray(value) && key === 'length') {
      return false;
    }

    return !(
      key === POEM_BRAND &&
      Reflect.get(value, key) === true &&
      !Object.prototype.propertyIsEnumerable.call(value, key)
    );
  });
}

export function assertRipples(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidDependencyError('Ripple entries must be an object or array');
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new InvalidDependencyError('Ripple arrays must not contain holes');
      }
    }
  }

  for (const key of rippleKeys(value)) {
    if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new InvalidDependencyError('Ripple entries must have enumerable string keys');
    }

    if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw new InvalidDependencyError('Ripple arrays must only contain indexed entries');
    }

    assertResolvable(Reflect.get(value, key));
  }
}
