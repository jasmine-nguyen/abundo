// The search box on Transactions and Rules (WHIT-846): magnifier, text input, and a 44pt clear button.
import { View, TextInput, Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { C, FONT, PRESSED } from '../theme';
import { Glyph } from '../icons';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  maxLength?: number;
  style?: StyleProp<ViewStyle>;
};

export function SearchField({ value, onChangeText, placeholder, accessibilityLabel, maxLength, style }: Props) {
  return (
    <View style={[styles.search, style]}>
      <Glyph name="search" size={18} color={C.placeholder} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.placeholder}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        maxLength={maxLength}
        accessibilityLabel={accessibilityLabel}
      />
      {value.length > 0 && (
        <Pressable
          onPress={() => onChangeText('')}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          style={({ pressed }) => [styles.clear, pressed && PRESSED]}
        >
          <Glyph name="close" size={16} color={C.textDim} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The clear button's 44pt box sets the row height, so the input and padding are trimmed to match.
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 13, paddingLeft: 14, paddingRight: 2 },
  input: { flex: 1, fontFamily: FONT.body, fontSize: 14, color: C.textBright, paddingVertical: 8, padding: 0 },
  clear: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
