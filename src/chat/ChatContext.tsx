// Card 609 — Ask Abundo's chat state: the conversation, the "is it answering" flag, the live
// "Looking at …" line, and the one-time consent. Its OWN provider (like NavBarsContext), not the
// hot src/context.tsx AppProvider. Mounted at the root so the thread survives tab switches and
// closing the sheet; the messages live in memory only, the consent is saved on the device.
//
// Answers come from a background job the app checks every second (the server can't stream),
// through the shared job poller (WHIT-629). Stop / New chat / sign-out stop the poller, and a
// generation counter drops a start request that settles after that.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAiChatJob, startAiChat } from '../api';
import type { ChatReply, ChatTurn } from '../api';
import { getStatus, subscribe } from '../auth';
import { pollJob } from '../jobPoller';
import type { PollHandle } from '../jobPoller';

export const CHAT_CONSENT_KEY = 'abundo.chatConsent';
export const CHAT_ERROR_TEXT = "Couldn't reach the assistant. Try again.";
// How often the app checks the job, and when it gives up: after this many dropped network calls
// in a row, or this long overall. 240s outlasts the chat worker's 210s timeout, so an answer the
// server finishes (and pays for) is always shown, and a spinner still can't run forever.
export const CHAT_POLL_DELAY_MS = 1000;
export const CHAT_MAX_NET_ERRORS = 5;
export const CHAT_MAX_WAIT_MS = 240_000;
// The server keeps only the last 20 messages; trimming here keeps the request small too.
const CHAT_MAX_HISTORY = 20;
// The server rejects any message longer than this (CHAT_MESSAGE_MAX_LEN in api_constants.py).
export const CHAT_MESSAGE_MAX_LEN = 2000;

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; status: 'done'; text: string; reply?: ChatReply }
  | { id: string; role: 'assistant'; status: 'error'; text: string };

// The conversation as the server wants it: user turns and finished answers only (an error bubble
// is dropped), each answer carrying its source so the model knows which period it used before.
export function chatHistory(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ role: 'user', text: message.text });
    } else if (message.status === 'done') {
      const source = message.reply?.source;
      turns.push({ role: 'assistant', text: source ? `${message.text} (Source: ${source})` : message.text });
    }
  }
  if (turns.length <= CHAT_MAX_HISTORY) return turns;
  // A trimmed history must start with a question: the server reads an answer-first history as the
  // insights summary seed, and the seed is only ever the thread's very first message.
  const kept = turns.slice(-CHAT_MAX_HISTORY);
  while (kept.length > 0 && kept[0].role === 'assistant') kept.shift();
  return kept;
}

export interface ChatContextValue {
  open: boolean;
  // Focus the text box on open — only when opened from "Ask a follow-up".
  autoFocus: boolean;
  consentLoaded: boolean;
  consentedAt: string | null;
  messages: ChatMessage[];
  inFlight: boolean;
  toolStatus: string | null;
  openChat: (options?: { seed?: string }) => void;
  closeChat: () => void;
  send: (text: string) => void;
  retry: () => void;
  stop: () => void;
  newChat: () => void;
  acceptConsent: () => void;
}

// Safe default so a screen that renders the Ask button or the insights card WITHOUT the provider
// (the bare screen tests) doesn't crash — the same stance as NavBarsContext.
const noop = () => {};
const DEFAULT_VALUE: ChatContextValue = {
  open: false, autoFocus: false, consentLoaded: false, consentedAt: null, messages: [],
  inFlight: false, toolStatus: null,
  openChat: noop, closeChat: noop, send: noop, retry: noop, stop: noop, newChat: noop, acceptConsent: noop,
};

const ChatCtx = createContext<ChatContextValue>(DEFAULT_VALUE);

export function useChat(): ChatContextValue {
  return useContext(ChatCtx);
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [autoFocus, setAutoFocus] = useState(false);
  const [consentLoaded, setConsentLoaded] = useState(false);
  const [consentedAt, setConsentedAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inFlight, setInFlight] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  // Bumped by every stop / restart, so a start request that resolves afterwards knows it's stale.
  const generation = useRef(0);
  const poller = useRef<PollHandle | null>(null);
  const nextId = useRef(0);
  const newId = () => `m${nextId.current++}`;

  useEffect(() => {
    // A failed read just shows the consent step again — never a blank sheet.
    AsyncStorage.getItem(CHAT_CONSENT_KEY).catch(() => null).then((value) => {
      setConsentedAt(value);
      setConsentLoaded(true);
    });
  }, []);

  const halt = useCallback(() => {
    generation.current += 1;
    poller.current?.stop();
    poller.current = null;
    setInFlight(false);
    setToolStatus(null);
  }, []);

  useEffect(() => halt, [halt]);

  const fail = useCallback((gen: number) => {
    if (gen !== generation.current) return;
    halt();
    setMessages((prev) => [...prev, { id: newId(), role: 'assistant', status: 'error', text: CHAT_ERROR_TEXT }]);
  }, [halt]);

  const run = useCallback(async (history: ChatTurn[]) => {
    halt();
    const gen = generation.current;
    const current = () => gen === generation.current;
    const startedAt = Date.now();
    setInFlight(true);

    try {
      const { jobId } = await startAiChat(history);
      if (!current()) return;
      poller.current = pollJob({
        jobId,
        check: (id) => getAiChatJob(id),
        isRunning: (job) => job.status === 'running',
        delayMs: CHAT_POLL_DELAY_MS,
        maxNetErrors: CHAT_MAX_NET_ERRORS,
        maxWaitMs: CHAT_MAX_WAIT_MS,
        startedAt,
        onProgress: (job) => setToolStatus(job.toolStatus ?? null),
        onDone: (job) => {
          const reply = job.reply;
          if (job.status !== 'succeeded' || !reply) { fail(gen); return; }
          halt();
          setMessages((prev) => [...prev, { id: newId(), role: 'assistant', status: 'done', text: reply.text, reply }]);
        },
        onFail: () => fail(gen),
      });
    } catch {
      fail(gen);
    }
  }, [halt, fail]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || inFlight) return;
    const next: ChatMessage[] = [...messages, { id: newId(), role: 'user', text: trimmed }];
    setMessages(next);
    run(chatHistory(next));
  }, [messages, inFlight, run]);

  // Resend the conversation up to the last question, replacing the error bubble.
  const retry = useCallback(() => {
    const last = messages[messages.length - 1];
    if (inFlight || !last || last.role !== 'assistant' || last.status !== 'error') return;
    const next = messages.slice(0, -1);
    setMessages(next);
    run(chatHistory(next));
  }, [messages, inFlight, run]);

  const newChat = useCallback(() => {
    halt();
    setMessages([]);
  }, [halt]);

  // "Ask a follow-up": a fresh thread that starts with the insights summary as the first answer.
  const openChat = useCallback((options?: { seed?: string }) => {
    const seed = options?.seed;
    if (seed) {
      halt();
      // Capped so a long summary can't make every question in the thread fail the server's check.
      setMessages([{ id: newId(), role: 'assistant', status: 'done', text: seed.slice(0, CHAT_MESSAGE_MAX_LEN) }]);
    }
    setAutoFocus(!!seed);
    setOpen(true);
  }, [halt]);

  const closeChat = useCallback(() => {
    setOpen(false);
    setAutoFocus(false);
  }, []);

  const acceptConsent = useCallback(() => {
    const now = new Date().toISOString();
    setConsentedAt(now);
    AsyncStorage.setItem(CHAT_CONSENT_KEY, now).catch(() => {});
  }, []);

  // Signing out clears the conversation (it's the user's spending). Consent stays on the device.
  useEffect(() => subscribe(() => {
    if (getStatus() !== 'anon') return;
    halt();
    setMessages([]);
    setOpen(false);
  }), [halt]);

  const value = useMemo<ChatContextValue>(() => ({
    open, autoFocus, consentLoaded, consentedAt, messages, inFlight, toolStatus,
    openChat, closeChat, send, retry, stop: halt, newChat, acceptConsent,
  }), [open, autoFocus, consentLoaded, consentedAt, messages, inFlight, toolStatus,
    openChat, closeChat, send, retry, halt, newChat, acceptConsent]);

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}
