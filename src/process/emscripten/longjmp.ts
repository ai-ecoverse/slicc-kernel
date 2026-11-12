import type { EmContext } from './context.ts';

export const LONGJMP = Number.POSITIVE_INFINITY;

function dynCallOf(
  ctx: EmContext,
  sig: string,
  index: number
): [string, (...args: never[]) => unknown] {
  const ex = ctx.exports();
  const named = ex[`dynCall_${sig}`];
  if (typeof named === 'function')
    return [`dynCall_${sig}`, named as (...args: never[]) => unknown];
  const table = ex.__indirect_function_table;
  const fn = table?.get(index) as ((...args: never[]) => unknown) | null | undefined;
  if (typeof fn !== 'function')
    throw new WebAssembly.RuntimeError('null function or function signature mismatch');
  return [`table:${index}`, fn];
}

export function invoke(ctx: EmContext, sig: string): (...args: unknown[]) => unknown {
  const returnsI64 = sig.startsWith('j');
  return (index, ...rest) => {
    const ex = ctx.exports();
    const save = ex.emscripten_stack_get_current as () => number;
    const restore = ex._emscripten_stack_restore as (sp: number) => void;
    const sp = save();
    try {
      const [name, fn] = dynCallOf(ctx, sig, index as number);
      const args = name.startsWith('dynCall_') ? [index, ...rest] : rest;
      return ctx.enter(name, fn, args);
    } catch (e) {
      restore(sp);
      if (e !== (e as number) + 0) throw e;
      (ex.setThrew as (threw: number, value: number) => void)(1, 0);
      return returnsI64 ? 0n : undefined;
    }
  };
}

export function invokeImports(
  ctx: EmContext,
  module: WebAssembly.Module
): WebAssembly.ModuleImports {
  const out: WebAssembly.ModuleImports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'env' || !imp.name.startsWith('invoke_')) continue;
    out[imp.name] = invoke(ctx, imp.name.slice('invoke_'.length));
  }
  return out;
}
