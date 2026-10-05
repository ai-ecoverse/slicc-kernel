export const BODY_IDLE_MS = 5 * 60 * 1000;

export function idleFailure(ms: number): Error {
  return Object.assign(new Error(`the response body sent no data for ${ms} ms`), {
    code: 'ETIMEDOUT',
  });
}

export async function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number
): Promise<ReadableStreamReadResult<T>> {
  if (!(ms > 0 && ms < Number.POSITIVE_INFINITY)) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(idleFailure(ms)), ms);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
  }
}
