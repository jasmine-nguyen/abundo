import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { pollJob } from '../jobPoller';
import { ApiError } from '../apiError';

type Job = { status: 'running' | 'succeeded' | 'failed'; step?: string };

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

describe('pollJob', () => {
  it('keeps checking one call at a time until the job finishes, riding out a few dropped connections', async () => {
    const pending: ReturnType<typeof deferred<Job>>[] = [];
    const check = jest.fn((_id: string) => {
      const next = deferred<Job>();
      pending.push(next);
      return next.promise;
    });
    const cb = callbacks();

    const handle = pollJob<Job>({
      jobId: 'job-1', check, isRunning,
      delayMs: DELAY, maxNetErrors: 3, ...cb,
    });

    // Nothing is checked before the first wait.
    await jest.advanceTimersByTimeAsync(DELAY - 1);
    expect(check).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('job-1');

    // A slow check never overlaps with the next one.
    await jest.advanceTimersByTimeAsync(DELAY * 5);
    expect(check).toHaveBeenCalledTimes(1);

    pending[0].resolve({ status: 'running', step: 'a' });
    await jest.advanceTimersByTimeAsync(0);
    expect(cb.onProgress).toHaveBeenCalledWith({ status: 'running', step: 'a' });

    // 2 dropped connections (one under the cap of 3) → keeps going.
    await jest.advanceTimersByTimeAsync(DELAY);
    pending[1].reject(new Error('Network request failed'));
    await jest.advanceTimersByTimeAsync(DELAY);
    pending[2].reject(new Error('Network request failed'));
    expect(cb.onFail).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(0);
    expect(handle.netErrors()).toBe(2);

    // A good answer resets the count.
    await jest.advanceTimersByTimeAsync(DELAY);
    pending[3].resolve({ status: 'running', step: 'b' });
    await jest.advanceTimersByTimeAsync(0);
    expect(handle.netErrors()).toBe(0);

    // 2 more drops would have hit the cap without the reset.
    await jest.advanceTimersByTimeAsync(DELAY);
    pending[4].reject(new Error('Network request failed'));
    await jest.advanceTimersByTimeAsync(DELAY);
    pending[5].reject(new Error('Network request failed'));
    await jest.advanceTimersByTimeAsync(DELAY);
    pending[6].resolve({ status: 'succeeded' });
    await jest.advanceTimersByTimeAsync(0);

    expect(cb.onFail).not.toHaveBeenCalled();
    expect(cb.onDone).toHaveBeenCalledTimes(1);
    expect(cb.onDone).toHaveBeenCalledWith({ status: 'succeeded' });
    expect(cb.onProgress).toHaveBeenCalledTimes(2);

    // Finished → no more checks.
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(check).toHaveBeenCalledTimes(7);
  });

  it('gives up when the job is gone, the connection keeps dropping or the time limit passes, and stops cleanly', async () => {

    // 404 → the job is gone.
    const gone = callbacks();
    pollJob<Job>({
      jobId: 'j', check: () => Promise.reject(new ApiError(404, null)), isRunning,
      delayMs: DELAY, maxNetErrors: 5, ...gone,
    });
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(gone.onFail).toHaveBeenCalledTimes(1);
    expect(gone.onFail).toHaveBeenCalledWith('expired');

    // 5 drops in a row → network. Starting from 3 carried-over drops, 2 more are enough.
    const dropping = callbacks();
    const dropCheck = jest.fn(() => Promise.reject(new Error('offline')));
    pollJob<Job>({
      jobId: 'j', check: dropCheck, isRunning,
      delayMs: DELAY, maxNetErrors: 5, initialNetErrors: 3, ...dropping,
    });
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(dropping.onFail).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(dropping.onFail).toHaveBeenCalledTimes(1);
    expect(dropping.onFail).toHaveBeenCalledWith('network');
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(dropCheck).toHaveBeenCalledTimes(2);

    // Time limit, measured from the given start → timeout, checked before calling the server.
    const slow = callbacks();
    const slowCheck = jest.fn(async () => ({ status: 'running' }) as Job);
    pollJob<Job>({
      jobId: 'j', check: slowCheck, isRunning,
      delayMs: DELAY, maxNetErrors: 5, maxWaitMs: 5_000, startedAt: Date.now() - 2_000, ...slow,
    });
    await jest.advanceTimersByTimeAsync(DELAY); // 3k elapsed at check → runs
    await jest.advanceTimersByTimeAsync(DELAY); // 4k elapsed → runs
    expect(slowCheck).toHaveBeenCalledTimes(2);
    expect(slow.onFail).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(DELAY); // 5k elapsed, not past the limit → runs
    expect(slowCheck).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(DELAY); // 6k elapsed → gives up without calling
    expect(slowCheck).toHaveBeenCalledTimes(3);
    expect(slow.onFail).toHaveBeenCalledTimes(1);
    expect(slow.onFail).toHaveBeenCalledWith('timeout');

    // stop() while a check is in flight → its answer is ignored and nothing re-arms.
    const stopped = callbacks();
    const inFlight = deferred<Job>();
    const stopCheck = jest.fn(() => inFlight.promise);
    const handle = pollJob<Job>({
      jobId: 'j', check: stopCheck, isRunning,
      delayMs: DELAY, maxNetErrors: 5, ...stopped,
    });
    await jest.advanceTimersByTimeAsync(DELAY);
    expect(stopCheck).toHaveBeenCalledTimes(1);
    handle.stop();
    inFlight.resolve({ status: 'running' });
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(stopCheck).toHaveBeenCalledTimes(1);
    expect(stopped.onProgress).not.toHaveBeenCalled();
    expect(stopped.onDone).not.toHaveBeenCalled();
    expect(stopped.onFail).not.toHaveBeenCalled();

    // stop() before the first check → never calls the server.
    const early = callbacks();
    const earlyCheck = jest.fn(() => Promise.resolve({ status: 'succeeded' } as Job));
    pollJob<Job>({
      jobId: 'j', check: earlyCheck, isRunning, delayMs: DELAY, maxNetErrors: 5, ...early,
    }).stop();
    await jest.advanceTimersByTimeAsync(DELAY * 10);
    expect(earlyCheck).not.toHaveBeenCalled();
    expect(early.onDone).not.toHaveBeenCalled();
  });
});

// WHIT-629 QA — 404 vs other errors, a rejected check after stop(), and terminal finality.
describe('pollJob edges', () => {

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
