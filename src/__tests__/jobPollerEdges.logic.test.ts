// WHIT-629 QA — the shared job poller's edges: stop() from inside a callback, 404 vs other errors,
// a rejected check after stop(), the clock boundary and default start, and give-up finality.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { pollJob } from '../jobPoller';
import type { PollHandle } from '../jobPoller';
import { ApiError } from '../apiError';

type Job = { status: 'running' | 'succeeded' | 'failed' };

const DELAY = 1000;
const isRunning = (job: Job) => job.status === 'running';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function callbacks() {
  return { onProgress: jest.fn(), onDone: jest.fn(), onFail: jest.fn() };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('pollJob edges', () => {
  it('[A1] stop() called from inside onProgress stops the loop — no further checks', async () => {
    const check = jest.fn(() => Promise.resolve<Job>({ status: 'running' }));
    let handle: PollHandle | null = null;
    const onProgress = jest.fn(() => handle?.stop());
    handle = pollJob<Job>({
      jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 5,
      onProgress, onDone: jest.fn(), onFail: jest.fn(),
    });
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(check).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('[A2] a 404 after some dropped connections is "expired", not "network", and ends at once', async () => {
    const cb = callbacks();
    const check = jest.fn<(id: string) => Promise<Job>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new ApiError(404, null))
      .mockResolvedValue({ status: 'running' });
    pollJob<Job>({ jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 5, ...cb });
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(cb.onFail).toHaveBeenCalledTimes(1);
    expect(cb.onFail).toHaveBeenCalledWith('expired');
    expect(check).toHaveBeenCalledTimes(3);
    expect(cb.onProgress).not.toHaveBeenCalled();
  });

  it('[A3] a non-404 server error counts as a dropped connection, not a gone job', async () => {
    const cb = callbacks();
    const check = jest.fn<(id: string) => Promise<Job>>()
      .mockRejectedValueOnce(new ApiError(500, null))
      .mockResolvedValueOnce({ status: 'succeeded' });
    const handle = pollJob<Job>({ jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 5, ...cb });
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(cb.onFail).not.toHaveBeenCalled();
    expect(handle.netErrors()).toBe(1);
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(cb.onDone).toHaveBeenCalledWith({ status: 'succeeded' });
    expect(cb.onFail).not.toHaveBeenCalled();
  });

  it('[A4] a check that REJECTS after stop() fires no callback and does not count or re-arm', async () => {
    const cb = callbacks();
    const inFlight = deferred<Job>();
    const check = jest.fn(() => inFlight.promise);
    const handle = pollJob<Job>({ jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 1, ...cb });
    await jest.advanceTimersByTimeAsync(DELAY);
    handle.stop();
    inFlight.reject(new ApiError(404, null));
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(cb.onFail).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    expect(handle.netErrors()).toBe(0);
  });

  it('[A5] a plain network drop after stop() is ignored too (maxNetErrors 1 would otherwise fail)', async () => {
    const cb = callbacks();
    const inFlight = deferred<Job>();
    const handle = pollJob<Job>({
      jobId: 'j', check: () => inFlight.promise, isRunning, delayMs: DELAY, maxNetErrors: 1, ...cb,
    });
    await jest.advanceTimersByTimeAsync(DELAY);
    handle.stop();
    inFlight.reject(new Error('offline'));
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(cb.onFail).not.toHaveBeenCalled();
  });

  it('[A6] the time limit counts from when polling starts by default, and exactly-at-limit still checks', async () => {
    let clock = 50_000;
    const cb = callbacks();
    const check = jest.fn(() => Promise.resolve<Job>({ status: 'running' }));
    pollJob<Job>({
      jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 5, maxWaitMs: 3_000, now: () => clock, ...cb,
    });
    clock = 53_000; // exactly at the limit → not past it
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(check).toHaveBeenCalledTimes(1);
    expect(cb.onFail).not.toHaveBeenCalled();
    clock = 53_001; // one ms past → gives up before calling the server
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(check).toHaveBeenCalledTimes(1);
    expect(cb.onFail).toHaveBeenCalledWith('timeout');
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(check).toHaveBeenCalledTimes(1);
    expect(cb.onFail).toHaveBeenCalledTimes(1);
  });

  it('[A7] without maxWaitMs there is no time limit', async () => {
    let clock = 0;
    const cb = callbacks();
    const check = jest.fn(() => { clock += 10_000_000; return Promise.resolve<Job>({ status: 'running' }); });
    pollJob<Job>({ jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 5, now: () => clock, ...cb });
    await jest.advanceTimersByTimeAsync(DELAY * 5);
    expect(check).toHaveBeenCalledTimes(5);
    expect(cb.onFail).not.toHaveBeenCalled();
  });

  it('[A8] giving up on the network reports the full count so a carry-over can read it', async () => {
    const cb = callbacks();
    const check = jest.fn(() => Promise.reject(new Error('offline')));
    const handle = pollJob<Job>({ jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 3, ...cb });
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(check).toHaveBeenCalledTimes(3);
    expect(cb.onFail).toHaveBeenCalledTimes(1);
    expect(handle.netErrors()).toBe(3);
  });

  it('[A9] a terminal job calls onDone once and never onProgress for that answer', async () => {
    const cb = callbacks();
    const check = jest.fn(() => Promise.resolve<Job>({ status: 'failed' }));
    pollJob<Job>({ jobId: 'j', check, isRunning, delayMs: DELAY, maxNetErrors: 5, ...cb });
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(check).toHaveBeenCalledTimes(1);
    expect(cb.onDone).toHaveBeenCalledTimes(1);
    expect(cb.onDone).toHaveBeenCalledWith({ status: 'failed' });
    expect(cb.onProgress).not.toHaveBeenCalled();
    expect(cb.onFail).not.toHaveBeenCalled();
  });
});
