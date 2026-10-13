export const TICKET_ENV = 'SLICC_SEALED_TICKET';
export const TICKET_TTL_MS = 30_000;
export const MAX_TICKETS = 256;

const TICKET = /^[0-9a-f]{32}$/;

export interface Booked {
  pid: number;
  path: string;
  argv: string;
  cwd: string;
  at: number;
}

export async function argvDigest(argv: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(argv));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, v]) => typeof v === 'string')
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
}

export class TicketBook {
  private readonly booked = new Map<string, Booked>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.booked.size;
  }

  async record(req: Record<string, unknown>, reply: object, pid: number): Promise<void> {
    const { ticket, error } = reply as { ticket?: unknown; error?: unknown };
    if (error !== undefined || typeof ticket !== 'string' || !TICKET.test(ticket)) return;
    const { path, argv, cwd } = req as { path: string; argv: string[]; cwd: string };
    const entry = { pid, path, argv: await argvDigest(argv), cwd, at: this.now() };
    this.prune();
    while (this.booked.size >= MAX_TICKETS)
      this.booked.delete(this.booked.keys().next().value as string);
    this.booked.set(ticket, entry);
  }

  take(ticket: string): Booked | undefined {
    const booked = this.booked.get(ticket);
    this.booked.delete(ticket);
    return booked && this.now() - booked.at < TICKET_TTL_MS ? booked : undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, booked] of this.booked) {
      if (now - booked.at >= TICKET_TTL_MS) this.booked.delete(ticket);
    }
  }
}
