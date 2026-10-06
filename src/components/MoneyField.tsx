import React from 'react';
import { View, Text, TextInput, StyleSheet, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { C, FONT } from '../theme';

export function MoneyField({
  label, labelStyle, hint, placeholder, value, onChangeText, prefix, suffix, style,
}: {
  label: string; labelStyle?: StyleProp<TextStyle>; hint?: string; placeholder: string; value: string;
  onChangeText: (t: string) => void; prefix?: string; suffix?: string; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      <Text style={labelStyle}>{label}</Text>
      <View style={styles.inputRow}>
        {prefix ? <Text style={styles.affix}>{prefix}</Text> : null}
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={C.placeholder}
          keyboardType="decimal-pad"
          inputMode="decimal"
        />
        {suffix ? <Text style={styles.affix}>{suffix}</Text> : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingHorizontal: 14, height: 50 },
  affix: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textDim },
  input: { flex: 1, fontFamily: FONT.body, fontSize: 16, color: C.text, height: '100%', textAlignVertical: 'center' },
  hint: { fontFamily: FONT.body, fontSize: 11.5, color: C.textFaint, marginTop: 5 },
});
