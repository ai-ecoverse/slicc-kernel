import { type DriverStart, hostDriver } from './mount/host.ts';
import { lockdown } from './process/js/lockdown.ts';

addEventListener(
  'message',
  (event) =>
    void hostDriver((event as MessageEvent<DriverStart>).data, (code) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      lockdown();
      return import(url);
    }),
  { once: true }
);
