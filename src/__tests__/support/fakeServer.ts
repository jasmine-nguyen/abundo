// WHIT-637 — an in-memory pretend server for the app tests, used instead of jest.mock('../api').
// The REAL src/api.ts runs; only global.fetch is swapped, so a test drives the same request step,
// error styles and body reads the app ships with. Usage in a suite (with the auth mock, which
// supplies the sign-in token api.ts asks for):
//
//   const server = installFakeServer();          // at the top of a describe (or the file)
//   server.seed('/categories', [GROCERIES]);     // what a read answers
//   server.fail('/rules', 409);                  // every call to that path fails with 409
//   const held = server.hold('/categories');     // replies wait until held.release()
//   held.fail('PATCH');                          // release as a lost connection; or held.fail('DELETE', { status: 500 })
//   server.once('GET', '/rules', { status: 503 }); // the next GET /rules only; 'dropped' = lost connection
//   expect(server.requests()).toEqual([...]);    // what the app sent, in order
//   expect(server.sent('POST', '/rules')).toHaveLength(1); // only that method + exact path
//
// seed / fail / hold / once take an exact path with no query string. The request log keeps
// the full path, query included. No timers of its own, so it works under jest fake timers.
import { beforeEach, afterEach } from '@jest/globals';

const API_BASE = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

export interface LoggedRequest {
  method: string;
  path: string;
  body: unknown;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Store = Map<string, unknown>;

interface Call {
  path: string;
  params: Record<string, string>;
  body: any;
  store: Store;
  nextId: (prefix: string) => string;
}

interface Reply {
  status: number;
  body: unknown;
}

type Queued = { status?: number; body?: unknown; reason?: string } | 'dropped';

class NotFound extends Error {}

const read = <T,>(store: Store, path: string, empty: T): T => (store.has(path) ? (store.get(path) as T) : empty);

const readSeeded = (empty: unknown) => ({ path, store }: Call) => read(store, path, empty);

const readOrNotFound = ({ path, store }: Call) => {
  if (!store.has(path)) throw new NotFound();
  return store.get(path);
};

function upsert(store: Store, path: string, record: { id: string }) {
  const list = read<{ id: string }[]>(store, path, []);
  const index = list.findIndex((item) => item.id === record.id);
  const next = index === -1 ? [...list, record] : list.map((item, i) => (i === index ? { ...item, ...record } : item));
  store.set(path, next);
  return next.find((item) => item.id === record.id);
}

function remove(store: Store, path: string, id: string) {
  store.set(path, read<{ id: string }[]>(store, path, []).filter((item) => item.id !== id));
  return { id };
}

function startJob({ store, nextId }: Call, prefix: string, jobsPath: string, extra: Record<string, unknown>) {
  const jobId = nextId(prefix);
  const job = { jobId, status: 'running', ...extra };
  store.set(`${jobsPath}/${jobId}`, job);
  return job;
}

const EMPTY_APPLY_RULES_JOB = {
  matched: 0, attempted: 0, filed: 0, vanished: 0, failed: 0, alreadyFiled: 0, remaining: 0,
  createdRule: null, error: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', completedAt: null,
};

const EMPTY_APPLY_RULES_RESULT = {
  dryRun: true, rulesConsidered: 0, unfiled: 0, matched: 0, conflicted: 0, conflictedSamples: [],
  byCategory: {}, byRule: [], skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [],
  remaining: 0, createdRule: null,
};

const APPLY_RULES_JOBS = '/transactions/uncategorized/apply-rules/jobs';
const CHAT_JOBS = '/ai/chat/jobs';

// Every route the app calls, as [method, path pattern, reply]. A `:name` segment matches one path part.
const ROUTES: [Method, string, (call: Call) => unknown][] = [
  ['GET', '/transactions', readSeeded([])],
  ['PATCH', '/transactions', ({ body }) => ({
    results: body.updates.map((update: { id: string }) => ({ id: update.id, status: 'updated' })),
  })],
  ['GET', '/transactions/feed', readSeeded({ transactions: [], nextCursor: null })],
  ['GET', '/transactions/uncategorized/feed', readSeeded({ transactions: [], nextCursor: null })],
  ['GET', '/transactions/search', readSeeded({ transactions: [], truncated: false })],
  ['GET', '/transactions/cycle', readSeeded({ start: '2026-07-01', end: '2026-07-08', transactions: [], budgets: {} })],
  ['GET', '/transactions/uncategorized/count', readSeeded({ count: 0 })],
  ['GET', '/transactions/uncategorized/merchants', readSeeded({ unfiled: 0, groups: [], ungrouped: { count: 0, samples: [] } })],
  ['GET', '/transactions/filing-suggestions', readSeeded({ suggestions: [] })],
  ['POST', '/transactions/uncategorized/apply-rules', readSeeded(EMPTY_APPLY_RULES_RESULT)],
  ['POST', APPLY_RULES_JOBS, (call) => startJob(call, 'job', APPLY_RULES_JOBS, EMPTY_APPLY_RULES_JOB)],
  ['GET', `${APPLY_RULES_JOBS}/:id`, readOrNotFound],
  ['PATCH', '/transactions/:id', ({ params, body }) => ({ transaction_id: params.id, ...body })],
  ['DELETE', '/transactions/:id', ({ params }) => ({ transaction_id: params.id })],
  ['POST', '/ai/chat', (call) => startJob(call, 'chat', CHAT_JOBS, {})],
  ['GET', `${CHAT_JOBS}/:id`, readOrNotFound],
  ['GET', '/categories', readSeeded([])],
  ['POST', '/categories', ({ store, body }) => upsert(store, '/categories', {
    id: body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), parent: null, ...body,
  })],
  ['PATCH', '/categories/:id', ({ store, params, body }) => upsert(store, '/categories', { id: params.id, ...body })],
  ['DELETE', '/categories/:id', ({ store, params }) => remove(store, '/categories', params.id)],
  ['GET', '/categories/:id/transactions', readSeeded([])],
  ['GET', '/budgets', readSeeded({})],
  ['GET', '/budgets/:id/transactions', readSeeded([])],
  ['PUT', '/budgets/:id', ({ params, body }) => ({ id: params.id, ...body })],
  ['DELETE', '/budgets/:id', ({ params }) => ({ id: params.id })],
  ['PUT', '/budgets/:id/spread', ({ params, body }) => ({ id: params.id, ...body })],
  ['DELETE', '/budgets/:id/spread', ({ params }) => ({ id: params.id })],
  ['GET', '/breakdown', readSeeded({})],
  ['GET', '/homeloan', readSeeded({ balance: null, as_of: null, currency: null })],
  ['GET', '/accounts/balances', readSeeded([])],
  ['POST', '/accounts/balances/refresh', ({ store }) => read(store, '/accounts/balances', [])],
  ['GET', '/goals', readSeeded([])],
  ['PUT', '/goals/:id', ({ store, params, body }) => upsert(store, '/goals', { ...body, id: params.id })],
  ['DELETE', '/goals/:id', ({ store, params }) => remove(store, '/goals', params.id)],
  ['GET', '/milestones', readSeeded([])],
  ['PUT', '/milestones', ({ store, body }) => {
    store.set('/milestones', body.milestones);
    return body.milestones;
  }],
  ['GET', '/repayment', readSeeded({ amount: null, date: null, principal: null, interest: null })],
  ['GET', '/loanfacts', readSeeded({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null })],
  ['PUT', '/loanfacts', ({ store, body }) => {
    store.set('/loanfacts', body);
    return body;
  }],
  ['GET', '/paycycle', readSeeded({ length: 14, last_pay_date: '2024-01-03' })],
  ['PUT', '/paycycle', ({ store, body }) => {
    store.set('/paycycle', body);
    return body;
  }],
  ['GET', '/rules', readSeeded([])],
  ['POST', '/rules', ({ store, body, nextId }) => upsert(store, '/rules', { id: nextId('rule'), ...body })],
  ['PUT', '/rules/:id', ({ store, params, body }) => upsert(store, '/rules', { id: params.id, ...body })],
  ['DELETE', '/rules/:id', ({ store, params }) => remove(store, '/rules', params.id)],
  ['GET', '/insights/ai', readSeeded({ summary: null, suggestions: [], generated_at: null, cycle_start: null, cached: false })],
  ['POST', '/insights/ai', ({ store }) => read(store, '/insights/ai', {
    summary: null, suggestions: [], generated_at: null, cycle_start: null, cached: false,
  })],
  ['POST', '/devices', ({ body }) => ({ token: body.token })],
];

function matchRoute(method: string, path: string) {
  const parts = path.split('/');
  for (const [routeMethod, pattern, reply] of ROUTES) {
    const patternParts = pattern.split('/');
    if (routeMethod !== method || patternParts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const matches = patternParts.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(parts[i]);
        return true;
      }
      return part === parts[i];
    });
    if (matches) return { reply, params };
  }
  return null;
}

// JSON round-trip: the app gets its own copy, as it would off the wire, and can't mutate the store.
const copy = <T,>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function response({ status, body }: Reply) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(copy(body)),
  } as Response;
}

function queuedReply({ status = 200, body, reason }: Exclude<Queued, 'dropped'>): Reply {
  if (status < 400) return { status, body };
  return { status, body: reason === undefined ? {} : { error: reason } };
}

function untilReleasedOrAborted(held: Promise<void>, signal?: AbortSignal | null) {
  if (!signal) return held;
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    held.then(resolve);
  });
}

export function installFakeServer() {
  let store: Store = new Map();
  let failures = new Map<string, Reply>();
  let holds = new Map<string, Promise<void>>();
  let openReleases = new Set<() => void>();
  let queued = new Map<string, Queued[]>();
  let log: LoggedRequest[] = [];
  let ids = 0;
  let realFetch: typeof fetch;

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const fullPath = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
    const path = fullPath.split('?')[0];
    const route = url.startsWith(API_BASE) ? matchRoute(method, path) : null;
    if (!route) throw new Error(`Fake server: no route for ${method} ${fullPath}`);

    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    log.push({ method, path: fullPath, body });

    const held = holds.get(path);
    if (held) await untilReleasedOrAborted(held, init?.signal);

    const next = queued.get(`${method} ${path}`)?.shift();
    if (next === 'dropped') throw new TypeError('Network request failed');
    if (next) return response(queuedReply(next));

    const failure = failures.get(path);
    if (failure) return response(failure);
    try {
      const nextId = (prefix: string) => `${prefix}-${++ids}`;
      return response({ status: 200, body: route.reply({ path, params: route.params, body, store, nextId }) });
    } catch (error) {
      if (error instanceof NotFound) return response({ status: 404, body: { error: 'Not found' } });
      throw error;
    }
  }

  beforeEach(() => {
    store = new Map();
    failures = new Map();
    holds = new Map();
    queued = new Map();
    log = [];
    ids = 0;
    realFetch = global.fetch;
    global.fetch = fakeFetch as typeof fetch;
  });

  // A failed assertion must not leave a request waiting forever (it would keep jest from exiting).
  afterEach(() => {
    openReleases.forEach((release) => release());
    openReleases = new Set();
    global.fetch = realFetch;
  });

  function queue(method: Method, path: string, reply: Queued) {
    const key = `${method} ${path}`;
    queued.set(key, [...(queued.get(key) ?? []), reply]);
  }

  return {
    /** Set what a path answers (a read's data, or the record list a write updates). */
    seed(path: string, data: unknown) {
      store.set(path, copy(data));
    },
    /** Make every call to this path fail with `status`; `reason` becomes the server's { error } text. */
    fail(path: string, status: number, reason?: string) {
      failures.set(path, queuedReply({ status, reason }));
    },
    /** Keep every call to this path waiting until release() (or the end of the test). */
    hold(path: string) {
      let resolveHold!: () => void;
      holds.set(path, new Promise<void>((resolve) => { resolveHold = resolve; }));
      const release = () => {
        holds.delete(path);
        openReleases.delete(release);
        resolveHold();
      };
      openReleases.add(release);
      return {
        release,
        /** Release as a failure: `method`'s next reply on this path is `reply` (default: lost connection). */
        fail(method: Method, reply: Queued = 'dropped') {
          queue(method, path, reply);
          release();
        },
      };
    },
    /** Answer only the next `method` call to this path with `reply`; queued replies go out in order. */
    once(method: Method, path: string, reply: Queued) {
      queue(method, path, reply);
    },
    /** Every request the app sent, in order: method, full path (query included) and parsed body. */
    requests(): LoggedRequest[] {
      return [...log];
    },
    /** Requests sent with this method to exactly this path (query included), in order. */
    sent(method: Method, path: string): LoggedRequest[] {
      return log.filter((request) => request.method === method && request.path === path);
    },
    /** Requests sent with this method to any path starting with `prefix`, in order. */
    sentUnder(method: Method, prefix: string): LoggedRequest[] {
      return log.filter((request) => request.method === method && request.path.startsWith(prefix));
    },
  };
}
