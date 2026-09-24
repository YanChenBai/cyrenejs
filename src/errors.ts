export class CyreneError extends Error {
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

  constructor(path: readonly string[], cause: unknown) {
    super(`Failed to resolve ${path.join(' -> ')}`, { cause });
    this.path = Object.freeze([...path]);
  }
}
