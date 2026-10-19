const sab = new SharedArrayBuffer(16);
const state = new Float64Array(sab);
const clock = `(() => {
  const real = performance.now.bind(performance);
  let state;
  self.addEventListener('message', (e) => {
    if (!e.data?.programClock) return;
    state = new Float64Array(e.data.programClock);
    e.stopImmediatePropagation();
  });
  performance.now = () => (state && state[0] === 1 ? state[1] - performance.timeOrigin : real());
})();
`;
const open = XMLHttpRequest.prototype.open;
const text = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;
let pending = false;
let programs;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this.programClock = String(url).includes('/process-worker.js');
  return open.call(this, method, url, ...rest);
};
Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
  get() {
    const body = text.call(this);
    if (!this.programClock) return body;
    pending = true;
    return clock + body;
  },
});
const blob = URL.createObjectURL;
URL.createObjectURL = (object) => {
  const url = blob(object);
  if (pending) programs = url;
  pending = false;
  return url;
};
const Real = self.Worker;
self.Worker = class extends Real {
  constructor(url, options) {
    super(url, options);
    if (String(url) === programs) super.postMessage({ programClock: sab });
  }
};
const control = new BroadcastChannel('notice-caches-program-clock');
control.onmessage = ({ data }) => {
  if (data.freeze) {
    state[1] = performance.timeOrigin + performance.now();
    state[0] = 1;
  }
  if (data.advance) state[1] += data.advance;
  if (data.thaw) state[0] = 0;
  control.postMessage({ done: data.id });
};
