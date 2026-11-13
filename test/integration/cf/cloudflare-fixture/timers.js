const pending = new Map();
const { setTimeout: startTimeout, setInterval: startInterval } = globalThis;
const { clearTimeout: stopTimeout, clearInterval: stopInterval } = globalThis;

const caller = () =>
  String(new Error().stack)
    .split('\n')
    .slice(3, 6)
    .map((line) => line.trim())
    .join(' < ');

globalThis.setTimeout = (run, ms, ...rest) => {
  const handle = startTimeout(
    (...args) => {
      pending.delete(handle);
      return run(...args);
    },
    ms,
    ...rest
  );
  pending.set(handle, { kind: 'timeout', ms, from: caller() });
  return handle;
};

globalThis.setInterval = (run, ms, ...rest) => {
  const handle = startInterval(run, ms, ...rest);
  pending.set(handle, { kind: 'interval', ms, from: caller() });
  return handle;
};

globalThis.clearTimeout = (handle) => {
  pending.delete(handle);
  return stopTimeout(handle);
};

globalThis.clearInterval = (handle) => {
  pending.delete(handle);
  return stopInterval(handle);
};

export const pendingTimers = () => [...pending.values()];
