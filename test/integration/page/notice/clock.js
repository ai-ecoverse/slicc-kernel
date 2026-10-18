const real = performance.now.bind(performance);
let frozen;
const control = new BroadcastChannel('notice-caches-clock');
control.onmessage = ({ data }) => {
  if (data.freeze) frozen = real();
  if (data.advance) frozen += data.advance;
  control.postMessage({ done: data.id });
};
performance.now = () => frozen ?? real();
