// WHIT-629: the one "is the background job done yet" loop, shared by the rules job and the chat.
// Each check is armed only after the previous one settles, so checks never overlap. No React.
import { ApiError } from './apiError';

export type PollFailure = 'expired' | 'network' | 'timeout';

export type PollJobOptions<J> = {
  jobId: string;
  check: (jobId: string) => Promise<J>;
  isRunning: (job: J) => boolean;
  delayMs: number;
  maxNetErrors: number;
  maxWaitMs?: number;
  startedAt?: number;
  initialNetErrors?: number;
  onProgress: (job: J) => void;
  onDone: (job: J) => void;
  onFail: (reason: PollFailure) => void;
};

export type PollHandle = { stop: () => void; netErrors: () => number };

// A 404 means the job is gone; other throws are dropped connections, retried up to maxNetErrors
// in a row. stop() (or a callback calling it) cuts off an in-flight check: its answer is ignored.
export function pollJob<J>(options: PollJobOptions<J>): PollHandle {
  const startedAt = options.startedAt ?? Date.now();
  let netErrors = options.initialNetErrors ?? 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
  };

  const fail = (reason: PollFailure) => {
    stop();
    options.onFail(reason);
  };

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(tick, options.delayMs);
  };

  async function tick() {
    timer = undefined;
    if (stopped) return;
    if (options.maxWaitMs !== undefined && Date.now() - startedAt > options.maxWaitMs) {
      fail('timeout');
      return;
    }
    let job: J;
    try {
      job = await options.check(options.jobId);
    } catch (e) {
      if (stopped) return;
      if (e instanceof ApiError && e.status === 404) {
        fail('expired');
        return;
      }
      netErrors += 1;
      if (netErrors >= options.maxNetErrors) {
        fail('network');
        return;
      }
      arm();
      return;
    }
    if (stopped) return;
    netErrors = 0;
    if (!options.isRunning(job)) {
      stop();
      options.onDone(job);
      return;
    }
    options.onProgress(job);
    arm();
  }

  arm();
  return { stop, netErrors: () => netErrors };
}
