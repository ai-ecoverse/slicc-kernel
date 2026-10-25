let reader: (error: Error) => unknown = (error) => error.stack;

export function setRawStack(read: (error: Error) => unknown): void {
  reader = read;
}

export function rawStack(error: Error): string | undefined {
  const stack = reader(error);
  return typeof stack === 'string' ? stack : undefined;
}
