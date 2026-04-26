/**
 * Shared mock helpers for fetch-metadata tests.
 *
 * Both fetch-metadata-schema.test.ts and fetch-metadata-ssrf.test.ts
 * mock `node:https.request` (the actual transport used by fetchMetadata).
 * Centralising the helpers here avoids duplication and keeps the
 * per-test files focused on assertions.
 */

import { EventEmitter } from 'node:events';
import https from 'node:https';
import { vi } from 'vitest';

/** Create a mock readable stream with a numeric statusCode property. */
export function makeMockStream(statusCode: number, body: string, chunked = false) {
  const emitter = new EventEmitter();
  (emitter as unknown as { statusCode: number }).statusCode = statusCode;
  (emitter as unknown as { [Symbol.asyncIterator]: () => AsyncIterableIterator<Buffer> })[
    Symbol.asyncIterator
  ] = async function* () {
    if (chunked && body.length > 1) {
      const half = Math.floor(body.length / 2);
      yield Buffer.from(body.slice(0, half));
      yield Buffer.from(body.slice(half));
    } else {
      yield Buffer.from(body);
    }
  };
  return emitter as NodeJS.ReadableStream & { statusCode: number };
}

/** Spy on https.request to synchronously call the callback with a mock stream. */
export function stubHttpsRequest(stream: ReturnType<typeof makeMockStream>) {
  return vi.spyOn(https, 'request').mockImplementation((_opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      setImmediate(() => (cb as (r: unknown) => void)(stream));
    }
    const req = new EventEmitter() as unknown as ReturnType<typeof https.request>;
    (req as unknown as { end: () => void }).end = () => {};
    (req as unknown as { destroy: (e?: Error) => void }).destroy = () => {};
    return req;
  });
}
