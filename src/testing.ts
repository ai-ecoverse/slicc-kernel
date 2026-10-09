import type { RouteTable } from './kernel/net/routes.ts';
import {
  answerOf,
  type NetworkUplink,
  type ResolveAnswer,
  type ResolveFamily,
} from './kernel/net/uplink.ts';

export type { NetworkUplink, ResolveAnswer, ResolveFamily, RouteTable };

export interface FakeUplinkOptions {
  names?: Readonly<Record<string, string[] | ResolveAnswer>>;
  routes?: RouteTable;
  ipv6?: boolean;
}

export interface FakeUplink extends NetworkUplink {
  readonly asked: Array<{ name: string; family: ResolveFamily }>;
}

export function fakeUplink(options: FakeUplinkOptions = {}): FakeUplink {
  const asked: FakeUplink['asked'] = [];
  return {
    traits: { tcp: true, udp: false, ipv6: options.ipv6 === true },
    ...(options.routes ? { routes: options.routes } : {}),
    asked,
    resolve: async (name, family) => {
      asked.push({ name, family });
      return answerOf(options.names?.[name] ?? []);
    },
  };
}
