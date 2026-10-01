// Card 609 — the Ask Abundo chat sheet: a one-time consent step, the empty state with suggested
// questions, the conversation, and the text box. A native page sheet, so swipe-down closes it
// (onRequestClose). Mounted once at the root, next to the other overlays, and only while signed in.
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, KeyboardAvoidingView, Modal, NativeScrollEvent, NativeSyntheticEvent, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { Glyph } from '../icons';
import { useReduceMotion } from '../motion/useReduceMotion';
import { useIsAuthed } from '../queries';
import type { ChatAction } from '../api';
import { CHAT_MESSAGE_MAX_LEN, useChat } from './ChatContext';
import { ChatAnswer } from './ChatAnswer';

export const SUGGESTED_PROMPTS = [
  'Analyse my spending',
  'Average Eating Out over the last 3 months',
  'Where did I overspend this cycle?',
  'How does this cycle compare to last?',
];

export function ChatSheet() {
  const chat = useChat();
  // The same privacy shield as Overlays: nothing about the user's spending over the sign-in or
  // Face ID lock screen.
  const isAuthed = useIsAuthed();
  if (!isAuthed) return null;
  let body = null;
  if (chat.consentLoaded && !chat.consentedAt) body = <ConsentStep />;
  else if (chat.consentLoaded) {
    body = (
      <>
        {chat.messages.length === 0 ? <EmptyState /> : <MessageList />}
        <Composer />
      </>
    );
  }
  return (
    <Modal
      visible={chat.open}
      presentationStyle="pageSheet"
      animationType="slide"
      onRequestClose={chat.closeChat}
    >
      <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.grabber} />
        <View style={[styles.header, chat.messages.length > 0 && styles.headerDivider]}>
          <Text style={styles.title}>Ask Abundo</Text>
          <View style={styles.headerRight}>
            {chat.messages.length > 0 && !!chat.consentedAt && (
              <Pressable testID="chat-new" onPress={chat.newChat} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.newChat}>New chat</Text>
              </Pressable>
            )}
            <Pressable
              testID="chat-close"
              onPress={chat.closeChat}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.close}
            >
              <Glyph name="close" size={15} color={C.textMid} />
            </Pressable>
          </View>
        </View>
        {body}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ConsentStep() {
  const { acceptConsent, closeChat } = useChat();
  return (
    <View testID="chat-consent" style={styles.consent}>
      <Text style={styles.consentTitle}>Let Abundo's assistant read your transactions?</Text>
      <Text style={styles.consentBody}>
        To answer questions, your transactions, categories and budgets are sent to our AI provider. Account and card numbers are never shared.
      </Text>
      <Pressable testID="chat-consent-continue" onPress={acceptConsent} accessibilityRole="button" style={styles.primaryBtn}>
        <Text style={styles.primaryBtnText}>Continue</Text>
      </Pressable>
      <Pressable testID="chat-consent-not-now" onPress={closeChat} accessibilityRole="button" style={styles.secondaryBtn}>
        <Text style={styles.secondaryBtnText}>Not now</Text>
      </Pressable>
    </View>
  );
}

function EmptyState() {
  const { send } = useChat();
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>What do you want to know about your spending?</Text>
      <Text style={styles.emptySub}>Ask about your transactions, budgets and categories, across your last 12 pay cycles.</Text>
      <View style={styles.prompts}>
        {SUGGESTED_PROMPTS.map((prompt, index) => (
          <Pressable
            key={prompt}
            testID={`chat-prompt-${index}`}
            onPress={() => send(prompt)}
            accessibilityRole="button"
            style={[styles.prompt, index === 0 && styles.promptHighlight]}
          >
            {index === 0 && <Glyph name="sparkle" size={18} color={C.purple} />}
            <Text style={[styles.promptText, index === 0 && styles.promptTextHighlight]}>{prompt}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function TypingIndicator({ status }: { status: string | null }) {
  const reduceMotion = useReduceMotion();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.35))).current;
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(Animated.stagger(160, dots.map((dot) => Animated.sequence([
      Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(dot, { toValue: 0.35, duration: 300, useNativeDriver: true }),
    ]))));
    loop.start();
    return () => loop.stop();
  }, [dots, reduceMotion]);
  return (
    <View testID="chat-typing" style={styles.typing}>
      <View style={styles.dots}>
        {dots.map((opacity, index) => <Animated.View key={index} style={[styles.typingDot, { opacity }]} />)}
      </View>
      {!!status && <Text testID="chat-tool-status" style={styles.toolStatus}>{status}</Text>}
    </View>
  );
}

function MessageList() {
  const { messages, inFlight, toolStatus, retry, send, closeChat } = useChat();
  const router = useRouter();
  const scrollRef = useRef<ScrollView>(null);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    setAtBottom(contentOffset.y + layoutMeasurement.height >= contentSize.height - 40);
  };
  const onAction = (action: ChatAction) => {
    if (action.kind === 'prompt') {
      send(action.text);
      return;
    }
    closeChat();
    router.push(`/category/${encodeURIComponent(action.categoryId)}?from=${action.dateFrom}&to=${action.dateTo}`);
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        testID="chat-messages"
        onScroll={onScroll}
        scrollEventThrottle={32}
        onContentSizeChange={() => { if (atBottom) scrollRef.current?.scrollToEnd({ animated: true }); }}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
      >
        {messages.map((message, index) => {
          if (message.role === 'user') {
            return <Text key={message.id} style={styles.userBubble}>{message.text}</Text>;
          }
          if (message.status === 'error') {
            return (
              <View key={message.id} testID="chat-error" style={styles.answerSlot}>
                <Text style={styles.errorText}>{message.text}</Text>
                {index === messages.length - 1 && !inFlight && (
                  <Pressable testID="chat-retry" onPress={retry} accessibilityRole="button" style={styles.retryChip}>
                    <Text style={styles.retryText}>Retry</Text>
                  </Pressable>
                )}
              </View>
            );
          }
          return (
            <View key={message.id} style={styles.answerSlot}>
              <ChatAnswer text={message.text} reply={message.reply} onAction={onAction} />
            </View>
          );
        })}
        {inFlight && <TypingIndicator status={toolStatus} />}
      </ScrollView>
      {!atBottom && (
        <Pressable
          testID="chat-jump"
          onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}
          accessibilityRole="button"
          accessibilityLabel="Jump to the latest message"
          style={styles.jump}
        >
          <Glyph name="arrowDown" size={16} color={C.text} />
        </Pressable>
      )}
    </View>
  );
}

function Composer() {
  const { messages, inFlight, autoFocus, send, stop } = useChat();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0 && !inFlight;
  const submit = () => {
    if (!canSend) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    send(text);
    setText('');
  };
  return (
    <View style={[styles.composer, { paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.composerRow}>
        <TextInput
          testID="chat-input"
          value={text}
          onChangeText={setText}
          placeholder={messages.length > 0 ? 'Ask a follow-up' : 'Ask about your spending'}
          placeholderTextColor={C.placeholder}
          autoFocus={autoFocus}
          multiline
          maxLength={CHAT_MESSAGE_MAX_LEN}
          style={styles.input}
        />
        {inFlight ? (
          <Pressable testID="chat-stop" onPress={stop} accessibilityRole="button" accessibilityLabel="Stop" style={[styles.sendBtn, styles.sendBtnIdle]}>
            <Glyph name="stopSquare" size={20} color={C.text} />
          </Pressable>
        ) : (
          <Pressable
            testID="chat-send"
            onPress={submit}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="Send"
            style={[styles.sendBtn, canSend ? styles.sendBtnReady : styles.sendBtnIdle]}
          >
            <Glyph name="arrowUp" size={20} color={canSend ? C.accentInk : C.placeholder} />
          </Pressable>
        )}
      </View>
      <Text style={styles.footnote}>Uses your transactions to answer · AI can make mistakes</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.chatSheet },
  grabber: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: C.chatChipBorder, marginTop: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingHorizontal: 18, paddingBottom: 12 },
  headerDivider: { borderBottomWidth: 1, borderBottomColor: C.chatControl },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  title: { fontFamily: FONT.display, fontSize: 17, fontWeight: '700', color: C.text },
  newChat: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.accent },
  close: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.chatControl, alignItems: 'center', justifyContent: 'center' },

  consent: { flex: 1, justifyContent: 'flex-end', padding: 22, gap: 14 },
  consentTitle: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', letterSpacing: -0.4, color: C.text },
  consentBody: { fontFamily: FONT.body, fontSize: 14, lineHeight: 21, color: C.textMid },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  primaryBtnText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.accentInk },
  secondaryBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', backgroundColor: C.chatControl },
  secondaryBtnText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.text },

  empty: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 18, paddingBottom: 16, gap: 22 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 24, fontWeight: '800', letterSpacing: -0.5, lineHeight: 27.6, color: C.text },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, lineHeight: 20.25, color: C.textMid, marginTop: -12 },
  prompts: { gap: 8 },
  prompt: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.chatPrompt, borderWidth: 1, borderColor: C.chatFieldBorder },
  promptHighlight: { backgroundColor: C.chatControl, borderWidth: 0 },
  promptText: { fontFamily: FONT.body, fontSize: 14.5, color: C.text },
  promptTextHighlight: { fontWeight: '600' },

  list: { padding: 18, gap: 16 },
  userBubble: {
    alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: C.accent, color: C.accentInk,
    fontFamily: FONT.body, fontSize: 14.5, fontWeight: '500', lineHeight: 21, overflow: 'hidden',
    paddingVertical: 11, paddingHorizontal: 14,
    borderTopLeftRadius: 18, borderTopRightRadius: 18, borderBottomLeftRadius: 18, borderBottomRightRadius: 6,
  },
  answerSlot: { alignSelf: 'stretch' },
  errorText: { fontFamily: FONT.body, fontSize: 14.5, lineHeight: 22.5, color: C.text },
  retryChip: { alignSelf: 'flex-start', height: 34, paddingHorizontal: 13, borderRadius: 17, borderWidth: 1, borderColor: C.chatChipBorder, justifyContent: 'center', marginTop: 12 },
  retryText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.accent },
  typing: { gap: 8 },
  dots: { flexDirection: 'row', gap: 5 },
  typingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.placeholder },
  toolStatus: { fontFamily: FONT.body, fontSize: 12, color: C.chatMuted },
  jump: { position: 'absolute', right: 18, bottom: 10, width: 34, height: 34, borderRadius: 17, backgroundColor: C.chatControl, alignItems: 'center', justifyContent: 'center' },

  composer: { borderTopWidth: 1, borderTopColor: C.chatControl, paddingTop: 12, paddingHorizontal: 14, gap: 8 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1, minHeight: 46, maxHeight: 110, borderRadius: 23, backgroundColor: C.bg, borderWidth: 1,
    borderColor: C.chatFieldBorder, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 13,
    fontFamily: FONT.body, fontSize: 15, color: C.text,
  },
  sendBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  sendBtnIdle: { backgroundColor: C.chatControl },
  sendBtnReady: { backgroundColor: C.accent },
  footnote: { textAlign: 'center', fontFamily: FONT.body, fontSize: 11.5, color: C.chatMuted },
});
