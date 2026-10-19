const warn = console.warn.bind(console);
const heard = new BroadcastChannel('kernel-warnings');
console.warn = (...args) => {
  heard.postMessage(args.map(String).join(' '));
  warn(...args);
};
