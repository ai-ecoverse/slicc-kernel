import type { NetworkLabel, Routes } from './routes.ts';
import type { RealmTransport } from './transport.ts';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    return '';
  }
}

export function refusal(
  host: string,
  label: NetworkLabel,
  routes: Routes | undefined
): string | undefined {
  if (label === 'none') return 'this process has network none, which reaches nothing';
  if (label !== 'uplink' && routes?.onUplink(host)) {
    return `${host} is on the uplink, which network ${label} may not use`;
  }
  return undefined;
}

export function labelled(
  transport: RealmTransport,
  label: NetworkLabel,
  routes: Routes | undefined
): RealmTransport {
  return {
    traits: transport.traits,
    fetch: (request) => {
      const refused = refusal(hostOf(request.url), label, routes);
      if (refused) {
        return Promise.reject(
          Object.assign(new Error(refused), { status: 502, code: 'ENETUNREACH' })
        );
      }
      return transport.fetch({ ...request, network: label });
    },
  };
}
