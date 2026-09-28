export function isFunction(value: unknown): value is Function {
  return typeof value === 'function';
}

export function isObject(value: unknown): value is object {
  return isFunction(value) || (typeof value === 'object' && value !== null);
}

/** 输入仅转换顶层可枚举属性，普通值和 Symbol 键保持原样。 */
export function inputEntries(value: object): [PropertyKey, unknown][] {
  return Reflect.ownKeys(value)
    .filter(key => Object.prototype.propertyIsEnumerable.call(value, key))
    .map(key => [key, Reflect.get(value, key)]);
}
