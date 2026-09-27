// Card 609 — one Ask Abundo answer: the text (key figures in bold), the optional bar card, the
// source line, and up to two action chips. Every number on the card was checked on the server
// against its own lookups; the app only draws it.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { C, FONT, fmt, fmtExact } from '../theme';
import { chartCategoryColor } from '../chartColors';
import { useCategories } from '../queries';
import type { ChatAction, ChatCard, ChatReply } from '../api';

const PLOT_HEIGHT = 124;

// "You spent **$214** per cycle" → plain and bold runs.
export function BoldText({ text, style }: { text: string; style: object }) {
  const parts = text.split('**');
  return (
    <Text style={style}>
      {parts.map((part, index) => (index % 2 === 1
        ? <Text key={index} style={styles.bold}>{part}</Text>
        : part))}
    </Text>
  );
}

// WHIT-615/617 — iOS keeps a shape's `%` lengths from its first draw, so the line stops short
// when the plot grows. Measure the row and draw with plain numbers instead.
function DashedLine() {
  const [width, setWidth] = React.useState(0);
  return (
    <View
      testID="chat-card-budget-line"
      style={styles.dashRow}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 && (
        <Svg width={width} height={2}>
          <Line x1={0} y1={1} x2={width} y2={1} stroke={C.text} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="5 4" />
        </Svg>
      )}
    </View>
  );
}

function AnswerCard({ card }: { card: ChatCard }) {
  const { category } = useCategories();
  const cardCategory = category(card.categoryId ?? null);
  const color = chartCategoryColor(card.categoryId, { slot: cardCategory?.colorSlot });
  const top = Math.max(...card.series.map((point) => point.value), card.budgetLine ?? 0, 1);
  const budgetY = card.budgetLine != null ? PLOT_HEIGHT - (card.budgetLine / top) * PLOT_HEIGHT : null;
  const delta = card.delta;
  // Above the comparison is bad for spending but good for an Income target (earned more).
  const deltaIsGood = delta != null && (cardCategory?.bucket === 'Income' ? delta.amount > 0 : delta.amount < 0);
  return (
    <View testID="chat-card" style={styles.card}>
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
          <View style={styles.cardLabelRow}>
            <View testID="chat-card-dot" style={[styles.dot, { backgroundColor: color }]} />
            <Text style={styles.cardLabel} numberOfLines={1}>{card.label}</Text>
          </View>
          <Text style={styles.cardValue}>{fmtExact(card.value)}</Text>
        </View>
        {delta && (
          <Text testID="chat-card-delta" style={[styles.delta, { color: deltaIsGood ? C.chatUnder : C.bad }]}>
            {delta.amount > 0 ? '+' : '−'}{fmtExact(delta.amount)} vs {delta.vs === 'budget' ? 'budget' : 'previous'}
          </Text>
        )}
      </View>
      {card.series.length > 0 && (
        <View>
          <View style={styles.plot}>
            {card.series.map((point, index) => (
              <View key={index} style={styles.barSlot}>
                <View
                  testID="chat-card-bar"
                  style={[styles.bar, { height: Math.max(2, (point.value / top) * PLOT_HEIGHT), backgroundColor: color }]}
                >
                  {point.value > 0 && <Text style={styles.barValue} numberOfLines={1}>{fmt(point.value)}</Text>}
                </View>
              </View>
            ))}
            {budgetY != null && (
              <View pointerEvents="none" style={[styles.budgetLine, { top: budgetY - 14 }]}>
                <Text style={styles.budgetLabel}>{fmt(card.budgetLine!)} budget</Text>
                <DashedLine />
              </View>
            )}
          </View>
          <View style={styles.axis}>
            {card.series.map((point, index) => (
              <Text key={index} style={styles.axisLabel} numberOfLines={1}>{point.label}</Text>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

export function ChatAnswer({ text, reply, onAction }: {
  text: string;
  reply?: ChatReply;
  onAction: (action: ChatAction) => void;
}) {
  return (
    <View style={styles.answer}>
      <BoldText text={text} style={styles.answerText} />
      {reply?.card && <AnswerCard card={reply.card} />}
      {!!reply?.source && <Text style={styles.source}>{reply.source}</Text>}
      {!!reply?.actions?.length && (
        <View style={styles.chips}>
          {reply.actions.map((action, index) => (
            <Pressable
              key={index}
              testID={`chat-action-${index}`}
              onPress={() => onAction(action)}
              accessibilityRole="button"
              style={styles.chip}
            >
              <Text style={[styles.chipText, { color: index === 0 ? C.accent : C.text }]}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  answer: { gap: 12 },
  answerText: { fontFamily: FONT.body, fontSize: 14.5, lineHeight: 22.5, color: C.text },
  bold: { fontWeight: '700' },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.chatCardBorder, borderRadius: 18, padding: 16, gap: 14 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardLabel: { fontFamily: FONT.body, fontSize: 12, color: C.textMid, flexShrink: 1 },
  cardValue: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', letterSpacing: -0.8, color: C.textBright, marginTop: 4 },
  delta: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700' },
  plot: { height: PLOT_HEIGHT, flexDirection: 'row', alignItems: 'flex-end', gap: 18 },
  barSlot: { flex: 1, justifyContent: 'flex-end' },
  bar: { borderTopLeftRadius: 7, borderTopRightRadius: 7, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, justifyContent: 'flex-end', alignItems: 'center', overflow: 'hidden' },
  barValue: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.accentInk, marginBottom: 6, fontVariant: ['tabular-nums'] },
  budgetLine: { position: 'absolute', left: 0, right: 0 },
  budgetLabel: { alignSelf: 'flex-end', fontFamily: FONT.body, fontSize: 10.5, color: C.textMid, marginBottom: 1 },
  dashRow: { height: 2 },
  axis: { flexDirection: 'row', gap: 18, marginTop: 6 },
  axisLabel: { flex: 1, textAlign: 'center', fontFamily: FONT.body, fontSize: 11.5, color: C.chatMuted },
  source: { fontFamily: FONT.body, fontSize: 11.5, color: C.chatMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 34, paddingHorizontal: 13, borderRadius: 17, borderWidth: 1, borderColor: C.chatChipBorder, justifyContent: 'center' },
  chipText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600' },
});
