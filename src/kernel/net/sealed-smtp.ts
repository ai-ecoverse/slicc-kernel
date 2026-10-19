import { SESSION_PLACEHOLDERS } from '../sealed-session.ts';
import { placeholdersIn, replaced, usable } from './sealed-http1.ts';

export const SMTP_LINE_MAX = 4096;

export type SmtpAsk = (
  position: 'auth-plain' | 'auth-login',
  placeholders: string[]
) => Promise<Record<string, string> | undefined>;

export interface SmtpLine {
  line: string;
  values?: Record<string, string>;
}

const GREETING = ['EHLO ', 'HELO '];

export function sniffSmtp(start: string): 'yes' | 'no' | 'more' {
  const upper = start.toUpperCase();
  for (const word of GREETING) {
    if (upper.startsWith(word)) return 'yes';
    if (word.startsWith(upper)) return 'more';
  }
  return 'no';
}

function decoded(b64: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return undefined;
  try {
    return atob(b64);
  } catch {
    return undefined;
  }
}

async function swapped(
  text: string,
  position: 'auth-plain' | 'auth-login',
  ask: SmtpAsk
): Promise<{ text: string; values: Record<string, string> } | undefined> {
  const placeholders = placeholdersIn(text);
  if (placeholders.length === 0 || placeholders.length > SESSION_PLACEHOLDERS) return undefined;
  const values = usable(await ask(position, placeholders));
  if (Object.keys(values).length === 0) return undefined;
  return { text: replaced(text, values), values };
}

async function plain(b64: string, ask: SmtpAsk): Promise<SmtpLine> {
  const text = decoded(b64);
  const fields = text?.split('\0');
  if (fields?.length !== 3) return { line: b64 };
  const [authz, user, pass] = fields as [string, string, string];
  if (placeholdersIn(authz + user).length > 0) return { line: b64 };
  const done = await swapped(pass, 'auth-plain', ask);
  if (!done) return { line: b64 };
  return { line: btoa(`${authz}\0${user}\0${done.text}`), values: done.values };
}

async function login(b64: string, ask: SmtpAsk): Promise<SmtpLine> {
  const text = decoded(b64);
  const done = text === undefined ? undefined : await swapped(text, 'auth-login', ask);
  return done ? { line: btoa(done.text), values: done.values } : { line: b64 };
}

type State = 'command' | 'plain' | 'user' | 'password' | 'done';

export class SmtpClient {
  private state: State = 'command';
  private readonly ask: SmtpAsk;
  constructor(ask: SmtpAsk) {
    this.ask = ask;
  }

  get done(): boolean {
    return this.state === 'done';
  }

  async line(text: string): Promise<SmtpLine> {
    const state = this.state;
    if (state === 'done') return { line: text };
    if (state === 'plain' || state === 'password') {
      this.state = 'done';
      if (text === '*') return { line: text };
      return state === 'plain' ? plain(text, this.ask) : login(text, this.ask);
    }
    if (state === 'user') {
      this.state = 'password';
      return { line: text };
    }
    return this.command(text);
  }

  private async command(text: string): Promise<SmtpLine> {
    const m = /^AUTH[ \t]+(PLAIN|LOGIN)(?:[ \t]+(\S+))?$/i.exec(text);
    if (!m) {
      if (/^(MAIL|RCPT|DATA|BDAT|AUTH)\b/i.test(text)) this.state = 'done';
      return { line: text };
    }
    const mech = (m[1] as string).toUpperCase();
    const arg = m[2];
    if (mech === 'LOGIN') {
      this.state = arg === undefined ? 'user' : 'password';
      return { line: text };
    }
    if (arg === undefined) {
      this.state = 'plain';
      return { line: text };
    }
    this.state = 'done';
    const out = await plain(arg, this.ask);
    return {
      line: `${text.slice(0, text.length - arg.length)}${out.line}`,
      ...(out.values ? { values: out.values } : {}),
    };
  }
}
