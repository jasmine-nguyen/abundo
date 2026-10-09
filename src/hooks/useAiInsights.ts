import { useCallback } from 'react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { generateAiInsights, type AiGoalSignal } from '../api';
import { useAppContext } from '../context';
import { aiInsightsKey, useAiInsightsQuery, useIsAuthed } from '../queries';

// AI spending insights (WHIT-104, WHIT-833). `refresh` re-reads the per-cycle cache (free, silent on
// failure — the shown summary stays); `generate` is the paid "Analyse my spending" action. `isError`
// is true only when the last GENERATE failed, so the button can offer a retry. `goal` is passed in at
// tap time, so it's never stale. queryClient.clear() on sign-out wipes the summary AND the runs.
export function useAiInsights() {
  const queryClient = useQueryClient();
  const query = useAiInsightsQuery(useIsAuthed());
  const { getSessionEpoch } = useAppContext();
  const { mutateAsync } = useMutation({
    mutationKey: aiInsightsKey,
    mutationFn: (goal?: AiGoalSignal | null) => generateAiInsights(goal),
    onMutate: () => getSessionEpoch(),
    // WHIT-268: a reply landing after sign-out is dropped, even if a new session is already live.
    onSuccess: async (result, _goal, epoch) => {
      if (epoch !== getSessionEpoch()) return;
      await queryClient.cancelQueries({ queryKey: aiInsightsKey });
      queryClient.setQueryData(aiInsightsKey, result);
    },
  });
  // The spinner / retry state is read from the shared run list, not this component's own run, so it
  // survives the coach card unmounting (the cycle toggle) mid-analyse.
  const statuses = useMutationState({ filters: { mutationKey: aiInsightsKey }, select: (mutation) => mutation.state.status });
  const lastStatus = statuses[statuses.length - 1];

  const { refetch } = query;
  const refresh = useCallback(() => refetch({ cancelRefetch: false }), [refetch]);
  const generate = useCallback((goal?: AiGoalSignal | null) => mutateAsync(goal).then(() => {}, () => {}), [mutateAsync]);

  return { insights: query.data ?? null, isLoading: lastStatus === 'pending', isError: lastStatus === 'error', generate, refresh };
}
