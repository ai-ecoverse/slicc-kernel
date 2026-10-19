export interface TestSyscall {
  pid: number;
  op: string;
}

export type TestSyscallHook = (call: TestSyscall) => Promise<void> | void;

const SYSCALL_HOOK = Symbol.for('slicc-kernel.test.syscall');

type HookHolder = { [SYSCALL_HOOK]?: TestSyscallHook };

export function testSyscallHook(): TestSyscallHook | undefined {
  return (globalThis as HookHolder)[SYSCALL_HOOK];
}

export function setTestSyscallHook(hook: TestSyscallHook | undefined): void {
  const holder = globalThis as HookHolder;
  if (hook) holder[SYSCALL_HOOK] = hook;
  else delete holder[SYSCALL_HOOK];
}
