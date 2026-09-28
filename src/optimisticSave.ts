// WHIT-628: the one runner for "update the screen now, undo if the save fails". Every save used
// to repeat these steps by hand; forgetting the session check let old data flash back (or a toast
// fire) after signing out. No React and no runtime imports from './context' (it imports this).

export type SaveSteps<R, T> = {
  apply?: () => (() => void) | void;
  send: () => Promise<R>;
  onSaved: (result: R) => T;
  onFailed: (error: unknown) => T;
  whenSignedOut: T;
};

// Only `send` sits inside the try, so a throw in onSaved never triggers a wrong undo. Signing out
// mid-save beats both the undo and onFailed (the WHIT-437 silent callers rethrow from onFailed).
export async function runOptimisticSave<R, T>(
  isSameSession: () => boolean,
  steps: SaveSteps<R, T>,
): Promise<T> {
  const undo = steps.apply?.();
  let result: R;
  try {
    result = await steps.send();
  } catch (error) {
    if (!isSameSession()) return steps.whenSignedOut;
    if (undo) undo();
    return steps.onFailed(error);
  }
  if (!isSameSession()) return steps.whenSignedOut;
  return steps.onSaved(result);
}
