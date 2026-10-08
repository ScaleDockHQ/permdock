/**
 * Applies method decorators to `cls.prototype[key]` without decorator syntax,
 * for projects limited to erasable TypeScript. Decorators apply in the order
 * given; each sees the descriptor the previous one left.
 */
export function decorateMethod(
  cls: { readonly prototype: object },
  key: string,
  ...decorators: readonly MethodDecorator[]
): void {
  for (const decorator of decorators) {
    const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, key);
    if (descriptor === undefined) {
      throw new TypeError(
        `decorateMethod: ${key} is not a method of the class`,
      );
    }
    const next = decorator(cls.prototype, key, descriptor);
    if (next !== undefined) {
      Object.defineProperty(cls.prototype, key, next);
    }
  }
}
