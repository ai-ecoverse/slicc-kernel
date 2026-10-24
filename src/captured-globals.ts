const here = globalThis as unknown as Record<string, unknown>;

function bound<T>(name: string): T {
  const value = here[name];
  return (typeof value === 'function' ? value.bind(here) : value) as T;
}

const capturedAbortController = here.AbortController as typeof globalThis.AbortController;

export { capturedAbortController as AbortController };

const capturedAbortSignal = here.AbortSignal as typeof globalThis.AbortSignal;

export { capturedAbortSignal as AbortSignal };

const capturedArray = here.Array as typeof globalThis.Array;

export { capturedArray as Array };

const capturedArrayBuffer = here.ArrayBuffer as typeof globalThis.ArrayBuffer;

export { capturedArrayBuffer as ArrayBuffer };

const capturedAtomics = here.Atomics as typeof globalThis.Atomics;

export { capturedAtomics as Atomics };

const capturedBigInt = here.BigInt as typeof globalThis.BigInt;

export { capturedBigInt as BigInt };

const capturedBigInt64Array = here.BigInt64Array as typeof globalThis.BigInt64Array;

export { capturedBigInt64Array as BigInt64Array };

const capturedBoolean = here.Boolean as typeof globalThis.Boolean;

export { capturedBoolean as Boolean };

const capturedBuffer = here.Buffer;

export { capturedBuffer as Buffer };

const capturedDataView = here.DataView as typeof globalThis.DataView;

export { capturedDataView as DataView };

const capturedDate = here.Date as typeof globalThis.Date;

export { capturedDate as Date };

const capturedDecompressionStream =
  here.DecompressionStream as typeof globalThis.DecompressionStream;

export { capturedDecompressionStream as DecompressionStream };

const capturedError = here.Error as typeof globalThis.Error;

export { capturedError as Error };

const capturedEvalError = here.EvalError as typeof globalThis.EvalError;

export { capturedEvalError as EvalError };

const capturedFunction = here.Function as typeof globalThis.Function;

export { capturedFunction as Function };

const capturedHeaders = here.Headers as typeof globalThis.Headers;

export { capturedHeaders as Headers };

const capturedInt32Array = here.Int32Array as typeof globalThis.Int32Array;

export { capturedInt32Array as Int32Array };

const capturedJSON = here.JSON as typeof globalThis.JSON;

export { capturedJSON as JSON };

const capturedMap = here.Map as typeof globalThis.Map;

export { capturedMap as Map };

const capturedMath = here.Math as typeof globalThis.Math;

export { capturedMath as Math };

const capturedNumber = here.Number as typeof globalThis.Number;

export { capturedNumber as Number };

const capturedObject = here.Object as typeof globalThis.Object;

export { capturedObject as Object };

const capturedPromise = here.Promise as typeof globalThis.Promise;

export { capturedPromise as Promise };

const capturedProxy = here.Proxy as typeof globalThis.Proxy;

export { capturedProxy as Proxy };

const capturedRangeError = here.RangeError as typeof globalThis.RangeError;

export { capturedRangeError as RangeError };

const capturedReadableStream = here.ReadableStream as typeof globalThis.ReadableStream;

export { capturedReadableStream as ReadableStream };

const capturedReflect = here.Reflect as typeof globalThis.Reflect;

export { capturedReflect as Reflect };

const capturedRequest = here.Request as typeof globalThis.Request;

export { capturedRequest as Request };

const capturedResponse = here.Response as typeof globalThis.Response;

export { capturedResponse as Response };

const capturedSet = here.Set as typeof globalThis.Set;

export { capturedSet as Set };

const capturedSharedArrayBuffer = here.SharedArrayBuffer as typeof globalThis.SharedArrayBuffer;

export { capturedSharedArrayBuffer as SharedArrayBuffer };

const capturedString = here.String as typeof globalThis.String;

export { capturedString as String };

const capturedSymbol = here.Symbol as typeof globalThis.Symbol;

export { capturedSymbol as Symbol };

const capturedSyntaxError = here.SyntaxError as typeof globalThis.SyntaxError;

export { capturedSyntaxError as SyntaxError };

const capturedTextDecoder = here.TextDecoder as typeof globalThis.TextDecoder;

export { capturedTextDecoder as TextDecoder };

const capturedTextEncoder = here.TextEncoder as typeof globalThis.TextEncoder;

export { capturedTextEncoder as TextEncoder };

const capturedTypeError = here.TypeError as typeof globalThis.TypeError;

export { capturedTypeError as TypeError };

const capturedURL = here.URL as typeof globalThis.URL;

export { capturedURL as URL };

const capturedUint8Array = here.Uint8Array as typeof globalThis.Uint8Array;

export { capturedUint8Array as Uint8Array };

const capturedWeakMap = here.WeakMap as typeof globalThis.WeakMap;

export { capturedWeakMap as WeakMap };

const capturedWeakSet = here.WeakSet as typeof globalThis.WeakSet;

export { capturedWeakSet as WeakSet };

const capturedWebAssembly = here.WebAssembly as typeof globalThis.WebAssembly;

export { capturedWebAssembly as WebAssembly };

const capturedWritableStream = here.WritableStream as typeof globalThis.WritableStream;

export { capturedWritableStream as WritableStream };

const capturedatob = bound<typeof globalThis.atob>('atob');

export { capturedatob as atob };

const capturedbtoa = bound<typeof globalThis.btoa>('btoa');

export { capturedbtoa as btoa };

const capturedclearTimeout = bound<typeof globalThis.clearTimeout>('clearTimeout');

export { capturedclearTimeout as clearTimeout };

const capturedcrypto = here.crypto as typeof globalThis.crypto;

export { capturedcrypto as crypto };

const capturedencodeURIComponent = here.encodeURIComponent as typeof globalThis.encodeURIComponent;

export { capturedencodeURIComponent as encodeURIComponent };

const capturedGlobalThis = globalThis;

export { capturedGlobalThis as globalThis };

const capturedperformance = here.performance as typeof globalThis.performance;

export { capturedperformance as performance };

const capturedprocess = here.process;

export { capturedprocess as process };

const capturedsetTimeout = bound<typeof globalThis.setTimeout>('setTimeout');

export { capturedsetTimeout as setTimeout };
