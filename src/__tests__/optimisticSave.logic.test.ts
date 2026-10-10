// WHIT-628 — one runner for "update the screen now, undo if the save fails".
//
// runOptimisticSave owns the order every save used to repeat by hand:
// apply → send → (signed out → whenSignedOut, touch nothing) / (failed → undo, then onFailed) /
// (ok → onSaved(result)). Signing out mid-save must beat both the undo and the toast, or old data
// gets re-planted into the next session.
import { describe, it, expect } from '@jest/globals';
import { runOptimisticSave } from '../optimisticSave';

function recorder() {
  const events: string[] = [];
  let sameSession = true;
  return {
    events,
    signOut: () => {
      sameSession = false;
    },
    isSameSession: () => sameSession,
  };
}

describe('runOptimisticSave', () => {
  it('updates the screen, sends, and hands the server result to onSaved without undoing', async () => {
    const r = recorder();

    const outcome = await runOptimisticSave(r.isSameSession, {
      apply: () => {
        r.events.push('apply');
        return () => r.events.push('undo');
      },
      send: async () => {
        r.events.push('send');
        return { id: 'saved-1' };
      },
      onSaved: (result: { id: string }) => {
        r.events.push(`saved:${result.id}`);
        return true;
      },
      onFailed: () => {
        r.events.push('failed');
        return false;
      },
      whenSignedOut: false,
    });

    expect(outcome).toBe(true);
    expect(r.events).toEqual(['apply', 'send', 'saved:saved-1']);
  });

  it('undoes the screen change before onFailed when the save fails', async () => {
    const r = recorder();
    const boom = new Error('boom');

    const outcome = await runOptimisticSave(r.isSameSession, {
      apply: () => {
        r.events.push('apply');
        return () => r.events.push('undo');
      },
      send: async () => {
        throw boom;
      },
      onSaved: () => {
        r.events.push('saved');
        return true;
      },
      onFailed: (error: unknown) => {
        r.events.push(error === boom ? 'failed:boom' : 'failed:other');
        return false;
      },
      whenSignedOut: false,
    });

    expect(outcome).toBe(false);
    expect(r.events).toEqual(['apply', 'undo', 'failed:boom']);
  });

  it('works without an apply step (a save that only updates after the server replies)', async () => {
    const r = recorder();

    const outcome = await runOptimisticSave(r.isSameSession, {
      send: async () => 42,
      onSaved: (result: number) => result + 1,
      onFailed: () => -1,
      whenSignedOut: 0,
    });

    expect(outcome).toBe(43);
  });

  it('signed out before a successful reply → whenSignedOut, onSaved never runs', async () => {
    const r = recorder();

    const outcome = await runOptimisticSave(r.isSameSession, {
      apply: () => {
        r.events.push('apply');
        return () => r.events.push('undo');
      },
      send: async () => {
        r.signOut();
        return 'ok';
      },
      onSaved: () => {
        r.events.push('saved');
        return 'saved';
      },
      onFailed: () => {
        r.events.push('failed');
        return 'failed';
      },
      whenSignedOut: 'signed-out',
    });

    expect(outcome).toBe('signed-out');
    expect(r.events).toEqual(['apply']);
  });

  it('signed out before a failed reply → whenSignedOut, no undo, no onFailed (even one that rethrows)', async () => {
    const r = recorder();

    const outcome = await runOptimisticSave(r.isSameSession, {
      apply: () => {
        r.events.push('apply');
        return () => r.events.push('undo');
      },
      send: async () => {
        r.signOut();
        throw new Error('boom');
      },
      onSaved: () => {
        r.events.push('saved');
        return 'saved';
      },
      onFailed: (error: unknown) => {
        r.events.push('failed');
        throw error;
      },
      whenSignedOut: null,
    });

    expect(outcome).toBeNull();
    expect(r.events).toEqual(['apply']);
  });

  it('an onFailed that rethrows (silent callers) propagates while still signed in, after the undo', async () => {
    const r = recorder();
    const boom = new Error('boom');

    await expect(
      runOptimisticSave(r.isSameSession, {
        apply: () => () => r.events.push('undo'),
        send: async () => {
          throw boom;
        },
        onSaved: () => 'saved',
        onFailed: (error: unknown) => {
          throw error;
        },
        whenSignedOut: null,
      }),
    ).rejects.toBe(boom);
    expect(r.events).toEqual(['undo']);
  });

  // [A1] WHIT-628 QA — the server accepted the save, so a broken onSaved must not undo it.
  it('a throwing onSaved rejects without undoing the saved change or calling onFailed', async () => {
    const r = recorder();
    const boom = new Error('onSaved broke');
    await expect(
      runOptimisticSave(r.isSameSession, {
        apply: () => () => r.events.push('undo'),
        send: async () => 'ok',
        onSaved: () => {
          throw boom;
        },
        onFailed: () => {
          r.events.push('failed');
          return 'failed';
        },
        whenSignedOut: 'out',
      }),
    ).rejects.toBe(boom);
    expect(r.events).toEqual([]);
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
});
