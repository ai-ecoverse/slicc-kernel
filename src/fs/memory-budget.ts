export const LEASE_FS_BYTES = 64 * 1024 * 1024;
export const LEASE_FS_ENTRIES = 4096;

export class MemoryBudget {
  private bytes = 0;
  private entries = 0;
  private closed = false;

  resize(before: number, after: number): void {
    if (this.closed) throw new DOMException('job ended', 'InvalidStateError');
    if (!Number.isSafeInteger(after) || after < 0 || this.bytes - before + after > LEASE_FS_BYTES) {
      throw new DOMException('lease file byte quota', 'QuotaExceededError');
    }
    this.bytes += after - before;
  }

  entry(add: 1 | -1): void {
    this.resize(0, 0);
    if (this.entries + add > LEASE_FS_ENTRIES)
      throw new DOMException('lease file count quota', 'QuotaExceededError');
    this.entries += add;
  }

  close(): void {
    this.closed = true;
  }
}
