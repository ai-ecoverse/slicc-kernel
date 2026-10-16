import { relative } from 'node:path';

const stacks = new Map();

function errorOf(details) {
  const error = details?.error;
  const cause = error?.cause ?? error;
  return String(cause?.message ?? cause ?? '').slice(0, 500);
}

function statusOf(type, data) {
  if (type === 'test:fail') {
    return data.details?.error?.failureType === 'cancelledByParent' ? 'cancelled' : 'fail';
  }
  if (data.skip) return 'skip';
  if (data.todo) return 'todo';
  return 'pass';
}

export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:start' && type !== 'test:pass' && type !== 'test:fail') continue;
    const file = data.file ? relative(process.cwd(), data.file) : '';
    const stack = stacks.get(file) ?? [];
    stacks.set(file, stack);
    if (type === 'test:start') {
      stack[data.nesting] = data.name;
      stack.length = data.nesting + 1;
      continue;
    }
    if (data.details?.type === 'suite' && type === 'test:pass') continue;
    const name = [...stack.slice(0, data.nesting), data.name].join(' > ');
    const status = statusOf(type, data);
    const row = { file, name, status, ms: Math.round(data.details?.duration_ms ?? 0) };
    if (status === 'fail') row.error = errorOf(data.details);
    yield `${JSON.stringify(row)}\n`;
  }
}
