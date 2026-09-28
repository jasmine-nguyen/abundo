// WHIT-629: the one filing run behind all three filing sheets — the "Apply my rules" sweep, file by
// shop and new rule. A sheet says what to file (a FilingTarget); this module picks "file now" or
// "background job" and answers with one FilingResult. The job state lives here too (it outlives the
// sheet, which unmounts on dismiss/lock). No runtime imports from './context' (it imports this).
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  applyRulesToUncategorized, startApplyRulesJob as apiStartApplyRulesJob, getApplyRulesJob as apiGetApplyRulesJob,
  type ApplyRulesResult, type ApplyRulesJob, type CreatedRule, type UncategorizedMerchantGroup,
} from './api';
import { ApiError } from './apiError';
import { patchTransactionsCache, refreshAfter } from './transactionCache';
import { pollJob, type PollHandle } from './jobPoller';

export type FilingTarget =
  | { kind: 'sweep' }
  | { kind: 'shop'; group: UncategorizedMerchantGroup; categoryId: string }
  | { kind: 'newRule'; pattern: string; categoryId: string; budgetExcluded: boolean };

// `background` says whether a clash or failure came from starting a job (the sheets toast) or from
// filing now (the sheets show the clash / "couldn't finish" screen).
export type FilingResult =
  | { status: 'filed'; report: ApplyRulesResult }
  | { status: 'background' }
  | { status: 'clash'; error: ApiError; background: boolean }
  | { status: 'failed'; background: boolean };

// "File now" (the sheets' "File up to 300" button, or any run at or under the cap) or let the
// matched count decide.
export type FilingWhen = { now: true; matched?: number } | { now?: false; matched: number };

type InlineRule = { value: string; categoryId: string; budgetExcluded?: boolean };

// Max charges ONE apply-rules request writes. Mirrors the server's APPLY_RULES_MAX_WRITES
// (lambda_api/api_constants.py) — the parity is asserted by applyRulesCap.logic.test.ts, since a
// comment alone drifts. The server can stop even earlier (a wall-clock budget), hence "up to" in
// the copy. Keep the two equal.
export const APPLY_RULES_MAX_WRITES = 300;

// WHIT-560: the background job's poll cadence. A dropped poll (offline) is NOT a job failure — the
// sweep keeps running server-side — so tolerate this many CONSECUTIVE network throws before giving
// up. A server `status:"failed"` or a 404 (expired) is terminal immediately.
const APPLY_RULES_JOB_POLL_DELAY_MS = 2500;
const APPLY_RULES_JOB_MAX_NET_ERRORS = 5;
// WHIT-565: a job stuck at `running` with no advancing progress for this many consecutive polls
// (~60s at 2500ms) shows a NON-destructive "taking longer than expected" nudge. Generous on
// purpose: a large history's planning phase reports 0 progress until the whole plan lands. The
// nudge does NOT stop the poll loop and self-clears the moment progress resumes.
const APPLY_RULES_JOB_MAX_STALL_POLLS = 24;

export function ruleFor(target: FilingTarget): InlineRule | undefined {
  if (target.kind === 'shop') return { value: target.group.rulePattern, categoryId: target.categoryId };
  if (target.kind === 'newRule') {
    return { value: target.pattern.trim(), categoryId: target.categoryId, budgetExcluded: target.budgetExcluded };
  }
  return undefined;
}

export function needsBackground(report: Pick<ApplyRulesResult, 'matched'>): boolean {
  return report.matched > APPLY_RULES_MAX_WRITES;
}

// Only the "add rule" run is started from the Rules screen, so only it shows its minted rule
// straight away with its NEW badge (and skips the rules refetch that would reset the badge).
export function prependsRule(target: FilingTarget): boolean {
  return target.kind === 'newRule';
}

function runRules(dryRun: boolean, rule: InlineRule | undefined): Promise<ApplyRulesResult> {
  // The plain sweep sends no rule argument at all, not an explicit undefined.
  if (!rule) return applyRulesToUncategorized(dryRun);
  return applyRulesToUncategorized(dryRun, rule);
}

// A 409 means an existing rule would fight the inline one. The plain sweep carries no inline rule,
// so it can't clash — anything it throws is a plain failure.
function clashFrom(target: FilingTarget, error: unknown): ApiError | null {
  if (target.kind === 'sweep') return null;
  return error instanceof ApiError && error.status === 409 ? error : null;
}

// A filed row stops matching the Uncategorized tab and disappears instantly; a vanished row is gone
// server-side. `alreadyFiled` is deliberately left alone: those rows still exist and now carry the
// category the user chose.
function patchFiledRows(report: ApplyRulesResult) {
  const filedBy = new Map(report.filed.map((row) => [row.id, row.category]));
  const vanished = new Set(report.vanished);
  if (filedBy.size === 0 && vanished.size === 0) return;
  patchTransactionsCache((prev) => prev
    .filter((existing) => !vanished.has(existing.transaction_id))
    .map((existing) => (filedBy.has(existing.transaction_id)
      ? { ...existing, category: filedBy.get(existing.transaction_id)! }
      : existing)));
}

const FAILED_NOW: FilingResult = { status: 'failed', background: false };
const FAILED_BACKGROUND: FilingResult = { status: 'failed', background: true };

export function useFilingRun({ sessionEpoch, prependMintedRule, sheetOpen }: {
  sessionEpoch: MutableRefObject<number>;
  prependMintedRule: (rule: CreatedRule) => void;
  sheetOpen: boolean;
}) {
  // WHIT-508: one filing run at a time, held here rather than in the sheet — dismissing the sheet
  // mid-write unmounts it, and reopening would otherwise let a second run start on top of the first.
  const inFlight = useRef(false);
  // WHIT-560: `applyRulesJob` is the status the job view renders. `jobActive` stays true from the
  // accepted POST until the job is terminal OR the session ends — the direct filing checks it too,
  // so nothing files on top of a running job even after the sheet is dismissed (polling stops on
  // dismiss and resumes on reopen; the lock does not).
  const [applyRulesJob, setApplyRulesJob] = useState<ApplyRulesJob | null>(null);
  const [applyRulesStalled, setApplyRulesStalled] = useState(false);
  const stallPolls = useRef(0);
  const lastProgress = useRef('');
  const jobId = useRef<string | null>(null);
  const jobActive = useRef(false);
  const jobStartEpoch = useRef(0);
  // Stopping the poller (terminal, dismiss, lock, sign-out) cuts off a check that was in flight, so
  // a dismiss-then-reopen never leaves two live chains. The dropped-connection count is carried
  // across a dismiss-then-reopen so the resumed poller keeps counting.
  const poller = useRef<PollHandle | null>(null);
  const netErrors = useRef(0);
  // The target of the RUNNING job, so "Try again" restarts the SAME run — even from a different
  // sheet than the one that started it (applyRulesJob is global).
  const jobTarget = useRef<FilingTarget | null>(null);

  const stopPolling = useCallback(() => {
    netErrors.current = poller.current?.netErrors() ?? netErrors.current;
    poller.current?.stop();
    poller.current = null;
  }, []);

  useEffect(() => () => poller.current?.stop(), []);

  // After a run: patch nothing further, just bring the server-derived reads back in line. A new
  // rule's minted rule is shown straight away, so its refresh leaves the rules list alone.
  const reconcileRules = useCallback((target: FilingTarget, createdRule: CreatedRule | null | undefined) => {
    if (createdRule && prependsRule(target)) {
      prependMintedRule(createdRule);
      refreshAfter('rulesApplied', { skipRules: true });
      return;
    }
    refreshAfter('rulesApplied');
  }, [prependMintedRule]);

  const previewFiling = useCallback(async (target: FilingTarget): Promise<FilingResult> => {
    const epoch = sessionEpoch.current;
    try {
      const report = await runRules(true, ruleFor(target));
      if (epoch !== sessionEpoch.current) return FAILED_NOW;
      return { status: 'filed', report };
    } catch (e) {
      if (epoch !== sessionEpoch.current) return FAILED_NOW;
      const clash = clashFrom(target, e);
      if (clash) return { status: 'clash', error: clash, background: false };
      return FAILED_NOW; // a preview writes nothing, so there is nothing to reconcile
    }
  }, [sessionEpoch]);

  // The server has already committed by the time it answers and says exactly which rows landed, so
  // there is no optimistic write and no rollback. A clash wrote nothing, so it refreshes nothing;
  // any other failure has an UNKNOWN outcome (the server writes row by row and reports at the end),
  // so it refreshes and lets the sheet say some charges may already have been filed.
  const fileNow = useCallback(async (target: FilingTarget): Promise<FilingResult> => {
    if (inFlight.current || jobActive.current) return FAILED_NOW;
    inFlight.current = true;
    const epoch = sessionEpoch.current;
    try {
      const report = await runRules(false, ruleFor(target));
      if (epoch !== sessionEpoch.current) return FAILED_NOW;
      patchFiledRows(report);
      reconcileRules(target, report.createdRule);
      return { status: 'filed', report };
    } catch (e) {
      if (epoch !== sessionEpoch.current) return FAILED_NOW;
      const clash = clashFrom(target, e);
      if (clash) return { status: 'clash', error: clash, background: false };
      refreshAfter('rulesApplied');
      return FAILED_NOW;
    } finally {
      inFlight.current = false;
    }
  }, [sessionEpoch, reconcileRules]);

  // Stop polling and release the "one run at a time" lock. Does NOT clear `applyRulesJob` — a
  // terminal frame stays on screen; the dismiss effect drops it when the sheet closes.
  const endJob = useCallback(() => {
    stopPolling();
    jobId.current = null;
    netErrors.current = 0;
    stallPolls.current = 0;
    lastProgress.current = '';
    setApplyRulesStalled(false);
    jobActive.current = false;
  }, [stopPolling]);

  // A terminal job: the GET returns counts, not id lists, so the async path can only refresh. A
  // failed job may still have filed some rows before dying, so it refreshes too.
  const finishJob = useCallback((job: ApplyRulesJob) => {
    endJob();
    setApplyRulesJob(job);
    const target = jobTarget.current;
    if (job.status === 'succeeded' && target) {
      reconcileRules(target, job.createdRule);
      return;
    }
    refreshAfter('rulesApplied');
  }, [endJob, reconcileRules]);

  // The job stopped without a server verdict — expired (404) or lost contact. Show the failed arm
  // with its retry, and still refresh, since a lost-contact job may have landed rows server-side.
  const failJob = useCallback((error: string) => {
    endJob();
    setApplyRulesJob((prev) => (prev ? { ...prev, status: 'failed', error } : prev));
    refreshAfter('rulesApplied');
  }, [endJob]);

  // A callback bails if the job was torn down (id cleared) or the session changed under it.
  const startPolling = useCallback((id: string) => {
    const startEpoch = jobStartEpoch.current;
    const superseded = () => jobId.current !== id || startEpoch !== sessionEpoch.current;
    const handle: PollHandle = pollJob<ApplyRulesJob>({
      jobId: id,
      check: (checkId) => apiGetApplyRulesJob(checkId),
      isRunning: (job) => job.status === 'running',
      delayMs: APPLY_RULES_JOB_POLL_DELAY_MS,
      maxNetErrors: APPLY_RULES_JOB_MAX_NET_ERRORS,
      initialNetErrors: netErrors.current,
      onProgress: (job) => {
        if (superseded()) { handle.stop(); return; }
        setApplyRulesJob(job);
        // WHIT-565: reset the stall count whenever progress advances; otherwise count unchanged
        // polls and raise the nudge at the threshold. The job keeps polling either way.
        const progress = `${job.matched}:${job.attempted}`;
        if (progress !== lastProgress.current) {
          lastProgress.current = progress;
          stallPolls.current = 0;
          setApplyRulesStalled(false);
          return;
        }
        stallPolls.current += 1;
        if (stallPolls.current >= APPLY_RULES_JOB_MAX_STALL_POLLS) setApplyRulesStalled(true);
      },
      onDone: (job) => {
        if (superseded()) return;
        finishJob(job);
      },
      onFail: (reason) => {
        if (superseded()) return;
        failJob(reason);
      },
    });
    poller.current = handle;
  }, [sessionEpoch, finishJob, failJob]);

  // Blocks if any filing run — direct OR a still-active job — is already going. On the accepted 202
  // it records the id, shows the first `running` frame, and starts polling.
  const startJob = useCallback(async (target: FilingTarget): Promise<FilingResult> => {
    if (inFlight.current || jobActive.current) return FAILED_BACKGROUND;
    jobActive.current = true;
    jobStartEpoch.current = sessionEpoch.current;
    jobTarget.current = target;
    netErrors.current = 0;
    stallPolls.current = 0;
    lastProgress.current = '';
    setApplyRulesStalled(false);
    try {
      const job = await apiStartApplyRulesJob(ruleFor(target));
      // A teardown during the POST wins. Sign-out bumps the session; a Face ID lock only clears
      // jobActive. Checking BOTH means neither can resurrect a job the teardown just cleared.
      if (!jobActive.current || jobStartEpoch.current !== sessionEpoch.current) {
        jobActive.current = false;
        return FAILED_BACKGROUND;
      }
      jobId.current = job.jobId;
      setApplyRulesJob(job);
      startPolling(job.jobId);
      return { status: 'background' };
    } catch (e) {
      jobActive.current = false;
      if (jobStartEpoch.current !== sessionEpoch.current) return FAILED_BACKGROUND;
      const clash = clashFrom(target, e);
      if (clash) return { status: 'clash', error: clash, background: true };
      return FAILED_BACKGROUND;
    }
  }, [sessionEpoch, startPolling]);

  const fileCharges = useCallback((target: FilingTarget, when: FilingWhen): Promise<FilingResult> => {
    if (!when.now && needsBackground(when)) return startJob(target);
    return fileNow(target);
  }, [startJob, fileNow]);

  // "Try again" re-runs the ORIGINAL target, whichever sheet shows it. It tears the current run down
  // FIRST so it works from both the failed arm and the WHIT-565 stall hint (a stalled job is still
  // `running` and holds the lock, which would otherwise refuse the restart).
  const retryApplyRulesJob = useCallback((): Promise<FilingResult> => {
    const target = jobTarget.current;
    if (!target) return Promise.resolve(FAILED_BACKGROUND);
    endJob();
    return startJob(target);
  }, [endJob, startJob]);

  // WHIT-560: a lock (or sign-out) unmounts the sheet, so stop polling and drop the job view — the
  // job keeps running server-side; on unlock the reopened sheet previews fresh.
  const endOnLock = useCallback(() => {
    endJob();
    setApplyRulesJob(null);
  }, [endJob]);

  // Polling follows an open overlay. While a sheet is open and a job is active but nothing is
  // polling (the sheet was just reopened after a dismiss), resume from the stored id. When the
  // overlay closes, stop polling only — the job keeps running server-side and the lock stays held,
  // so a reopen resumes the same job — and drop a terminal frame so the next open previews fresh.
  useEffect(() => {
    if (sheetOpen) {
      if (jobActive.current && jobId.current && !poller.current) startPolling(jobId.current);
      return;
    }
    stopPolling();
    if (!jobActive.current) setApplyRulesJob(null);
  }, [sheetOpen]);

  return { previewFiling, fileCharges, retryApplyRulesJob, applyRulesJob, applyRulesStalled, endOnLock };
}
