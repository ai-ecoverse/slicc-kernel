import { type DriverStart, hostDriver } from './mount/host.ts';

addEventListener(
  'message',
  (event) =>
    void hostDriver(
      (event as MessageEvent<DriverStart>).data,
      (code) => import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
    ),
  { once: true }
);
