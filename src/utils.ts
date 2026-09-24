export function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function entries(value: object): [PropertyKey, unknown][] {
  // 同时保留字符串键和 Symbol 键, 忽略继承属性与不可枚举属性
  return Reflect.ownKeys(value)
    .filter(key => Object.prototype.propertyIsEnumerable.call(value, key))
    .map(key => [key, Reflect.get(value, key)]);
}
