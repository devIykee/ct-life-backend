/**
 * Rugpull Factory: name and ticker validation.
 *
 * Coin names and tickers are shown to every player (Pulse board, Timeline,
 * Sleuth posts), so they pass a strict allow-list of characters and a
 * profanity / slur / link filter. The check is on a normalised form of the
 * text (case, accents, leetspeak, separators and repeated letters removed) so
 * "f.u.c.k" and "FUUUCK" are caught too.
 *
 * The filter is deliberately blunt: a false positive costs a player a retry,
 * a false negative puts a slur on the city's screens.
 */
import { chatFilter } from './llm-filter.js';

export const NAME_MIN = 2;
export const NAME_MAX = 24;
export const TICKER_MIN = 2;
export const TICKER_MAX = 6;

/** Letters, digits, single spaces and a few separators. */
const NAME_CHARS = /^[A-Za-z0-9][A-Za-z0-9 .'!_-]*$/;
const TICKER_CHARS = /^[A-Z0-9]+$/;

/** Matched anywhere in the squashed text. Slurs and strong profanity. */
const BLOCK_SUBSTRING: readonly string[] = [
  'fuck',
  'shit',
  'cunt',
  'bitch',
  'asshole',
  'dickhead',
  'cocksuck',
  'motherfuck',
  'bastard',
  'whore',
  'slut',
  'nigg',
  'fagg',
  'retard',
  'tranny',
  'kike',
  'chink',
  'gook',
  'wetback',
  'rapist',
  'nazi',
  'hitler',
  'killyourself',
  'molest',
  'childporn',
  'cheesepizza',
  'porn',
  'hentai',
  'cumshot',
  'blowjob',
  'jihad',
];

/** Matched only as a whole token, for words that sit inside innocent ones. */
const BLOCK_TOKEN: readonly string[] = [
  'ass',
  'dick',
  'cock',
  'pussy',
  'cum',
  'tit',
  'tits',
  'fag',
  'dyke',
  'paki',
  'rapes',
  'sex',
  'nsfw',
  'anal',
  'piss',
  'slave',
  'coon',
  'spic',
  'kys',
  'isis',
  'rape',
  'pedo',
];

/** Brands and look-alikes the parody must not pass itself off as. */
const BLOCK_BRAND: readonly string[] = ['pumpfun', 'pumpdotfun', 'official', 'ctlifeteam', 'admin'];

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
};

function normalise(raw: string): string {
  const base = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let out = '';
  for (const ch of base) out += LEET[ch] ?? ch;
  return out;
}

/** Letters only, repeated letters collapsed: "f.u.u.c.k" -> "fuck". */
function squash(raw: string): string {
  return normalise(raw)
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function tokens(raw: string): string[] {
  return normalise(raw)
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/(.)\1{2,}/g, '$1$1'));
}

/**
 * True when the text carries a blocked word, link, e-mail, phone number or
 * wallet-like string.
 * @param raw - A name or ticker.
 */
export function isBlockedText(raw: string): boolean {
  const squashed = squash(raw);
  // The block lists are squashed the same way ("nigg" stays "nig").
  for (const w of BLOCK_SUBSTRING) {
    if (squashed.includes(w.replace(/(.)\1+/g, '$1'))) return true;
  }
  for (const b of BLOCK_BRAND) {
    if (squashed.includes(b)) return true;
  }
  const toks = new Set(tokens(raw));
  for (const w of BLOCK_TOKEN) {
    if (toks.has(w)) return true;
  }
  if (/\.(com|io|xyz|fun|gg|app|net|org|sol)\b/i.test(raw)) return true;
  return chatFilter(raw).filtered;
}

export interface CleanCoinText {
  readonly name: string;
  readonly ticker: string;
}

/**
 * Validate and normalise a coin name and ticker.
 * @param name - The raw name.
 * @param ticker - The raw ticker.
 * @returns The trimmed name and upper-case ticker, or `null` when either is not allowed.
 */
export function cleanCoinText(name: string, ticker: string): CleanCoinText | null {
  const n = name.trim().replace(/\s+/g, ' ');
  const t = ticker.trim().toUpperCase();
  if (n.length < NAME_MIN || n.length > NAME_MAX || !NAME_CHARS.test(n)) return null;
  if (t.length < TICKER_MIN || t.length > TICKER_MAX || !TICKER_CHARS.test(t)) return null;
  if (isBlockedText(n) || isBlockedText(t)) return null;
  return { name: n, ticker: t };
}
