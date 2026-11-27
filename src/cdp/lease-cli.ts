import type { Attestation, AttestTombstone } from '../fs/attest.ts';
import { fsError, type KernelFs } from '../fs/types.ts';

export const CLI_PKG = '/node_modules/@ai-ecoverse/slicc-cdp';
export const CLI_FILE = `${CLI_PKG}/bin/playwright-cli.wasm`;
export const CLI_MAX = 8 * 1024 * 1024;
export const LEASE_USER = 'leasejob';

export interface LeaseCliInput {
  wasm: Uint8Array;
  sha256: string;
}

export function checkCli({ wasm, sha256 }: LeaseCliInput): void {
  if (
    !(wasm instanceof Uint8Array) ||
    wasm.length < 8 ||
    wasm.length > CLI_MAX ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw fsError('EINVAL', 'invalid lease CLI image or SHA-256');
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

const MANIFEST = JSON.stringify({
  name: '@ai-ecoverse/slicc-cdp',
  slicc: { abi: 'wasi', commands: { 'playwright-cli': { wasm: 'bin/playwright-cli.wasm' } } },
});

export class LeaseCliImage {
  private state: 'new' | 'installing' | 'installed' | 'attested' | 'closed' = 'new';
  private sha: string | undefined;
  private readonly fs: KernelFs;
  constructor(fs: KernelFs) {
    this.fs = fs;
  }

  async install(input: LeaseCliInput): Promise<void> {
    if (this.state !== 'new') throw fsError('EPERM', 'lease CLI installation is one-shot');
    this.state = 'installing';
    try {
      checkCli(input);
      const bytes = new Uint8Array(input.wasm);
      const sha = input.sha256;
      if ((await digest(bytes)) !== sha) throw fsError('EACCES', 'lease CLI digest mismatch');
      this.active();
      await this.fs.mkdir(`${CLI_PKG}/bin`, { recursive: true });
      await this.fs.writeFile(CLI_FILE, bytes, { uid: 0, gid: 0, mode: 0o555 });
      await this.fs.writeFile(`${CLI_PKG}/package.json`, MANIFEST, { uid: 0, gid: 0, mode: 0o444 });
      if ((await digest(await this.fs.readFileBuffer(CLI_FILE))) !== sha)
        throw fsError('EACCES', 'installed lease CLI digest mismatch');
      this.active();
      this.sha = sha;
      this.state = 'installed';
    } catch (err) {
      this.close();
      throw err;
    }
  }
  private active(): void {
    if (this.state === 'closed') throw fsError('EPERM', 'lease job ended');
  }
  attest(record: Attestation | AttestTombstone): void {
    if (record.path !== CLI_FILE) return;
    if (
      (this.state !== 'installed' && this.state !== 'attested') ||
      !('sha256' in record) ||
      record.sha256 !== this.sha ||
      record.uid !== 0 ||
      (record.mode & 0o222) !== 0
    )
      throw fsError('EACCES', 'lease CLI attestation failed');
    this.state = 'attested';
  }
  ready(): void {
    if (this.state !== 'attested')
      throw fsError('EACCES', 'install and attest the lease CLI first');
  }
  async bytes(path: string): Promise<Uint8Array> {
    this.ready();
    if (path !== CLI_FILE) throw fsError('EACCES', 'only the installed lease CLI can execute');
    const bytes = await this.fs.readFileBuffer(path);
    if (bytes.length > CLI_MAX || (await digest(bytes)) !== this.sha)
      throw fsError('EACCES', 'lease CLI digest changed');
    this.ready();
    return bytes;
  }
  close(): void {
    this.state = 'closed';
    this.sha = undefined;
  }
}
