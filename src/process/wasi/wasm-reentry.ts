export function reentered<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return fn;
}
