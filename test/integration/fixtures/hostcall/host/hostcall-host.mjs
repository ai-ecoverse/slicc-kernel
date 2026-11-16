const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ctxCall = (fn) => ({ fn });

function* readAll(ctx, handle) {
  const parts = [];
  for (;;) {
    const bytes = yield ctxCall(() => ctx.syscall({ op: 'net-read', handle, max: 65536 }));
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) break;
    parts.push(decoder.decode(bytes, { stream: true }));
  }
  yield ctxCall(() => ctx.syscall({ op: 'net-close', handle }));
  return parts.join('') + decoder.decode();
}

function* drain(ctx, fd) {
  let out = '';
  for (;;) {
    const id = yield ctxCall(() => ctx.async.submit({ op: 'fd-read', fd, max: 65536 }));
    while ((yield ctxCall(() => ctx.async.wait())) !== id);
    const taken = yield ctxCall(() => ctx.async.take(id));
    const bytes = taken?.value;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) break;
    out += decoder.decode(bytes);
  }
  yield ctxCall(() => ctx.syscall({ op: 'fd-close', fd }));
  return out;
}

function* operation(ctx, request) {
  switch (request.op) {
    case 'echo':
      return { argv: ctx.argv, cwd: yield ctxCall(() => ctx.cwd()) };
    case 'exists':
      return yield ctxCall(() => ctx.fs.exists(request.path));
    case 'http': {
      const head = yield ctxCall(() =>
        ctx.syscall({
          op: 'net-request',
          url: request.url,
          method: request.method ?? 'GET',
          headers: request.headers ?? [],
        })
      );
      return { status: head.status, body: yield* readAll(ctx, head.handle) };
    }
    case 'run': {
      const child = yield ctxCall(() =>
        ctx.spawn({ argv: request.argv, stdin: 'null', stdout: 'pipe', stderr: 'inherit' })
      );
      const stdout = yield* drain(ctx, child.stdout);
      const { status } = yield ctxCall(() => ctx.wait(child.pid));
      return { status, stdout };
    }
    default:
      throw new Error(`unknown operation ${request.op}`);
  }
}

function answered(state, response) {
  state.result = encoder.encode(JSON.stringify(response));
  return state.result.length;
}

function request(ctx, pointer, size) {
  const bytes = new Uint8Array(ctx.memory().buffer, pointer, size);
  return JSON.parse(decoder.decode(bytes.slice()));
}

function namespace(ctx, state, call) {
  return {
    host_call: {
      call,
      take: (pointer) => {
        new Uint8Array(ctx.memory().buffer).set(state.result, pointer);
        state.result = new Uint8Array(0);
      },
    },
  };
}

export function createImports(ctx) {
  const state = { result: new Uint8Array(0) };
  return namespace(ctx, state, (pointer, size) => {
    try {
      const steps = operation(ctx, request(ctx, pointer, size));
      let step = steps.next();
      while (!step.done) {
        let value;
        try {
          value = step.value.fn();
        } catch (err) {
          step = steps.throw(err);
          continue;
        }
        step = steps.next(value);
      }
      return answered(state, { ok: true, value: step.value });
    } catch (err) {
      return answered(state, { ok: false, error: err?.code ?? String(err?.message ?? err) });
    }
  });
}

export function createAsyncImports(ctx) {
  const state = { result: new Uint8Array(0) };
  return namespace(ctx, state, async (pointer, size) => {
    try {
      const steps = operation(ctx, request(ctx, pointer, size));
      let step = steps.next();
      while (!step.done) {
        let value;
        try {
          value = await step.value.fn();
        } catch (err) {
          step = steps.throw(err);
          continue;
        }
        step = steps.next(value);
      }
      return answered(state, { ok: true, value: step.value });
    } catch (err) {
      return answered(state, { ok: false, error: err?.code ?? String(err?.message ?? err) });
    }
  });
}
