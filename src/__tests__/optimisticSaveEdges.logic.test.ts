// WHIT-628 QA — edges of runOptimisticSave the main contract test doesn't pin: a throwing
// onSaved must not undo a save the server accepted, a synchronously-throwing send is still a
// failure, and the session is read only once the send has settled.
import { describe, it, expect } from '@jest/globals';
import { runOptimisticSave } from '../optimisticSave';

describe('runOptimisticSave edges', () => {
  // [A1]
  it('a throwing onSaved rejects without undoing the saved change or calling onFailed', async () => {
    const events: string[] = [];
    const boom = new Error('onSaved broke');
    await expect(
      runOptimisticSave(() => true, {
        apply: () => () => events.push('undo'),
        send: async () => 'ok',
        onSaved: () => {
          throw boom;
        },
        onFailed: () => {
          events.push('failed');
          return 'failed';
        },
        whenSignedOut: 'out',
      }),
    ).rejects.toBe(boom);
    expect(events).toEqual([]);
  });

  // [A2]
  it('a send that throws synchronously (not a rejected promise) is still a failure: undo then onFailed', async () => {
    const events: string[] = [];
    const boom = new Error('sync');
    const outcome = await runOptimisticSave(() => true, {
      apply: () => () => events.push('undo'),
      send: () => {
        throw boom;
      },
      onSaved: () => 'saved',
      onFailed: (error: unknown) => {
        events.push(error === boom ? 'failed:boom' : 'failed:other');
        return 'failed';
      },
      whenSignedOut: 'out',
    });
    expect(outcome).toBe('failed');
    expect(events).toEqual(['undo', 'failed:boom']);
  });

  // [A3]
  it('apply runs once, before send is called; send runs exactly once', async () => {
    const events: string[] = [];
    await runOptimisticSave(() => true, {
      apply: () => {
        events.push('apply');
      },
      send: async () => {
        events.push('send');
        return 1;
      },
      onSaved: () => events.push('saved'),
      onFailed: () => events.push('failed'),
      whenSignedOut: 0,
    });
    expect(events).toEqual(['apply', 'send', 'saved']);
  });

  // [A4]
  it('an apply with no undo still reaches onFailed on failure', async () => {
    const outcome = await runOptimisticSave(() => true, {
      apply: () => undefined,
      send: async () => {
        throw new Error('x');
      },
      onSaved: () => 'saved',
      onFailed: () => 'failed',
      whenSignedOut: 'out',
    });
    expect(outcome).toBe('failed');
  });

  // [A5]
  it('undo runs exactly once on failure', async () => {
    let undos = 0;
    await runOptimisticSave(() => true, {
      apply: () => () => {
        undos += 1;
      },
      send: async () => {
        throw new Error('x');
      },
      onSaved: () => null,
      onFailed: () => null,
      whenSignedOut: null,
    });
    expect(undos).toBe(1);
  });

  // [A6]
  it('the session is checked only after send settles, never before', async () => {
    const events: string[] = [];
    await runOptimisticSave(
      () => {
        events.push('check');
        return true;
      },
      {
        apply: () => {
          events.push('apply');
        },
        send: async () => {
          events.push('send');
          return 1;
        },
        onSaved: () => events.push('saved'),
        onFailed: () => events.push('failed'),
        whenSignedOut: 0,
      },
    );
    expect(events).toEqual(['apply', 'send', 'check', 'saved']);
  });

  // [A7]
  it('returns whenSignedOut by identity (false / undefined kept distinct from onFailed results)', async () => {
    const outcome = await runOptimisticSave(() => false, {
      send: async () => 'ok',
      onSaved: () => true,
      onFailed: () => false,
      whenSignedOut: undefined as boolean | undefined,
    });
    expect(outcome).toBeUndefined();
  });

  // [A8]
  it('an apply that throws rejects before anything is sent', async () => {
    let sent = false;
    await expect(
      runOptimisticSave(() => true, {
        apply: () => {
          throw new Error('apply broke');
        },
        send: async () => {
          sent = true;
        },
        onSaved: () => null,
        onFailed: () => null,
        whenSignedOut: null,
      }),
    ).rejects.toThrow('apply broke');
    expect(sent).toBe(false);
  });
});
