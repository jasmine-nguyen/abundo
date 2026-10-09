import { useCallback, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { generateAiInsights, type AiGoalSignal } from '../api';
import { getStatus, subscribe } from '../auth';
import { useAppContext } from '../context';
import { aiInsightsKey, useAiInsightsQuery, useIsAuthed } from '../queries';

// AI spending insights (WHIT-104, WHIT-833). `refresh` re-reads the per-cycle cache (free, silent on
// failure — the shown summary stays); `generate` is the paid "Analyse my spending" action. `isError`
// is true only when the last GENERATE failed, so the button can offer a retry. `goal` is passed in at
// tap time, so it's never stale. queryClient.clear() wipes the summary on sign-out.
export function useAiInsights() {
  const queryClient = useQueryClient();
  const query = useAiInsightsQuery(useIsAuthed());
  const { getSessionEpoch } = useAppContext();
  const mutation = useMutation({
    mutationFn: (goal?: AiGoalSignal | null) => generateAiInsights(goal),
    onMutate: () => getSessionEpoch(),
    // WHIT-268: a reply landing after sign-out is dropped, even if a new session is already live.
    onSuccess: async (result, _goal, epoch) => {
      if (epoch !== getSessionEpoch()) return;
      await queryClient.cancelQueries({ queryKey: aiInsightsKey });
      queryClient.setQueryData(aiInsightsKey, result);
    },
  });

  // Sign-out drops the spinner / retry state; a late settle of the old run can't touch it after.
  const { reset } = mutation;
  useEffect(() => subscribe(() => { if (getStatus() === 'anon') reset(); }), [reset]);

  const { refetch } = query;
  const refresh = useCallback(() => refetch({ cancelRefetch: false }), [refetch]);
  const { mutateAsync } = mutation;
  const generate = useCallback((goal?: AiGoalSignal | null) => mutateAsync(goal).then(() => {}, () => {}), [mutateAsync]);

  return { insights: query.data ?? null, isLoading: mutation.isPending, isError: mutation.isError, generate, refresh };
}
