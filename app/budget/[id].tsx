import { useLocalSearchParams } from 'expo-router';
import { BudgetDetailView } from '../../src/screens/BudgetDetailView';

export default function BudgetDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <BudgetDetailView id={id} />;
}
