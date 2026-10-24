import { useLocalSearchParams } from 'expo-router';
import { AccountDetailView } from '../../src/screens/AccountDetailView';

export default function AccountDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AccountDetailView id={id} />;
}
