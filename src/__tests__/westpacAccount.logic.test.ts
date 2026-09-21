// WHIT-490 — the user-visible consequence of the Westpac card's merchant spelling: the app's
// name-tidying map now holds BOTH spellings of one clinic, so a single search for
// what the user actually sees has to find the charge on either card.
// format.logic.test.ts pins cleanName itself; this pins the search behaviour that
// depends on it, which is where a missing entry would actually be noticed.
import { describe, it, expect } from '@jest/globals';
import { merchantLabel, transactionMatchesSearch } from '../context';
import { txn } from './factory';

const noCategory = () => undefined;

// The real Westpac massage row, in the shape the app receives it from /transactions.
const massage = txn({
  transaction_id: 'bank_tx_b220e370', date: '2026-09-02', authorized_date: '2026-09-02',
  description: 'UNIFLEXREMEDIALMASSAGE ALTONA NORT AUS', merchant_name: 'UNIFLEXREMEDIALMASSAGE',
  amount: -155, account_id: 'westpac-altitude-qantas-black',
  account_name: 'Altitude Qantas Black Card', category: 'health',
});
// The same clinic charged on the ANZ card, which spells it with spaces.
const anzMassage = txn({
  transaction_id: 'anz_1', description: 'UNIFLEX REMEDIAL MASSAGE  ALTONA NORTH   AU',
  merchant_name: 'UNIFLEX REMEDIAL MASSAGE', amount: -155,
  account_id: 'anz-rewards-black-visa', account_name: 'ANZ Rewards Black Visa', category: 'health',
});

describe('one merchant, two bank spellings', () => {
  it('a single search for the display name finds BOTH cards\' charges', () => {
    // Searching what the user actually SEES ("Uniflex Massage") must return the charge
    // from either card. Without the unspaced CLEAN_NAME entry the Westpac row's label and
    // description are both unspaced, so this query misses it entirely.
    const s = { category: noCategory };
    expect(transactionMatchesSearch(s, anzMassage, 'uniflex massage')).toBe(true);
    expect(transactionMatchesSearch(s, massage, 'uniflex massage')).toBe(true);
    // The raw unspaced descriptor still matches its own row (a search from the feed text).
    expect(transactionMatchesSearch(s, massage, 'UNIFLEXREMEDIALMASSAGE')).toBe(true);
  });

  it('the mapping does not swallow a different merchant that merely starts the same', () => {
    // The lookup is exact-match, not prefix — a longer look-alike must keep its own name.
    const other = txn({ merchant_name: 'UNIFLEXREMEDIALMASSAGETHERAPY', description: 'UNIFLEXREMEDIALMASSAGETHERAPY' });
    expect(merchantLabel(other)).toBe('UNIFLEXREMEDIALMASSAGETHERAPY');
  });
});
