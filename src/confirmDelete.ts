import { Alert } from 'react-native';

/** The shared "are you sure?" pop-up for a delete that can't be undone: Cancel / Delete (red). */
export function confirmDelete(title: string, body: string, onConfirm: () => void) {
  Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}
