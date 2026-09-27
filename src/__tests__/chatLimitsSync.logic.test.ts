// Card 609 — the chat's client limits are hand copies of server numbers; this keeps them in step.
//
// - CHAT_MESSAGE_MAX_LEN: the server 400s any longer message, so a longer client cap (composer or
//   follow-up seed) would make every question in the thread fail.
// - CHAT_MAX_HISTORY: the client trims to the same count the server keeps, so the "start on a
//   question" trim happens here and the server never has to drop the thread's first turns.
// - CHAT_MAX_WAIT_MS: the app must keep checking past the worker's Lambda timeout, or an answer
//   the server finishes (and pays for) is never shown.
//
// Same shape as applyRulesTimeout.logic.test.ts: read the sources, don't import across languages.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const readSource = (repoRelative: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', repoRelative), 'utf8');

// A throw here means a constant was renamed or moved. Fix the mirror — do not loosen the regex.
function num(source: string, pattern: RegExp): number {
  const match = source.match(pattern);
  expect(match).not.toBeNull();
  return Number(match![1].replace(/_/g, ''));
}

const client = readSource('src/chat/ChatContext.tsx');
const server = readSource('lambda_api/api_constants.py');
const terraform = readSource('terraform/lambda.tf');

describe('the chat client limits match the server', () => {
  it('caps a message at the same length the server accepts', () => {
    expect(num(client, /^export const CHAT_MESSAGE_MAX_LEN = ([\d_]+);/m))
      .toBe(num(server, /^CHAT_MESSAGE_MAX_LEN\s*=\s*(\d+)/m));
  });

  it('trims the history to the same count the server keeps', () => {
    expect(num(client, /^const CHAT_MAX_HISTORY = ([\d_]+);/m))
      .toBe(num(server, /^CHAT_MAX_MESSAGES\s*=\s*(\d+)/m));
  });

  it('keeps checking for an answer past the worker timeout, with headroom', () => {
    const waitMs = num(client, /^export const CHAT_MAX_WAIT_MS = ([\d_]+);/m);
    const worker = terraform.slice(terraform.indexOf('resource "aws_lambda_function" "ai_chat_worker"'));
    const workerMs = num(worker, /timeout\s*=\s*(\d+)/) * 1000;
    expect(waitMs - workerMs).toBeGreaterThanOrEqual(10_000);
  });
});
