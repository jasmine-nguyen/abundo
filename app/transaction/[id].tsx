import { useLocalSearchParams } from 'expo-router';
import { TransactionDetailView } from '../../src/screens/TransactionDetailView';

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TransactionDetailView id={id} />;
}
