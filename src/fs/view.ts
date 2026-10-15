export function view<T extends object>(target: T, overrides: Record<string, unknown>): T {
  const keys = new Set(Object.keys(overrides));
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (keys.has(prop as string)) return overrides[prop as string];
      return Reflect.get(t, prop, receiver);
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value);
    },
    getPrototypeOf(t) {
      return Reflect.getPrototypeOf(t);
    },
  });
}
