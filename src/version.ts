declare const SLICC_VERSION: string | undefined;

export const KERNEL_VERSION = typeof SLICC_VERSION === 'string' ? SLICC_VERSION : '0.0.0-dev';
export const OS_RELEASE = ['6.0.0', 'slicc'].join('-');

export function procVersion(): string {
  return `Linux version ${OS_RELEASE} (slicc-kernel ${KERNEL_VERSION}) #1 SMP PREEMPT_DYNAMIC\n`;
}
