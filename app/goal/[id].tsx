import { useLocalSearchParams } from 'expo-router';
import { GoalDetailView } from '../../src/screens/GoalDetailView';

export default function GoalDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <GoalDetailView id={id} />;
}
