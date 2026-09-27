export class CyreneError extends Error {
  /** 保留原生 cause 支持，并把错误名称设为具体子类，便于调用方和日志区分错误类别。 */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CircularDependencyError extends CyreneError {}

export class InvalidDependencyError extends CyreneError {}

export class DisposedError extends CyreneError {}

export class ResolutionError extends CyreneError {
  readonly path: readonly string[];

  /** 冻结解析路径的副本并保留原始失败原因，避免外部修改路径后改变诊断信息。 */
  constructor(path: readonly string[], cause: unknown) {
    super(`Failed to resolve ${path.join(' -> ')}`, { cause });
    this.path = Object.freeze([...path]);
  }
}
