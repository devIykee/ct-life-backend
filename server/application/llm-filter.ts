/**
 * Chat filter for the M7 #8 LLM NPC chat (AI Agent + Sleuth).
 *
 * Pure functions. The filter strips:
 *
 *   - HTTP/HTTPS links (http://, https://, www.)
 *   - Phone numbers (10+ digit runs, with optional + and separators)
 *   - Email addresses (local@domain patterns)
 *   - Wallet addresses (32-44 char base58/hex runs)
 *   - Profanity (curated list)
 *
 * The filter is applied to BOTH the user's input (before the
 * model is called) and the model's output (before the
 * response is returned). PII stripping is a defense-in-depth
 * measure; the master prompt's M7 #8 gate requires the LLM
 * output filter to "have no PII leakage" and to be
 * "prompt-injection-resistant" — the latter is the system
 * prompt's job, not this filter's.
 *
 * The filter is intentionally conservative: when in doubt, it
 * strips. The `filtered` flag on the llm_npc_interactions row
 * records when the output was modified.
 */

const LINK_PATTERNS: ReadonlyArray<RegExp> = [/\bhttps?:\/\/\S+/gi, /\bwww\.\S+/gi];

const PHONE_PATTERNS: ReadonlyArray<RegExp> = [
  /\+?\d[\d\s().-]{8,}\d/g,
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
];

const EMAIL_PATTERN = /\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;

// Solana / Ethereum / Bitcoin style addresses: 32-44 char
// base58/hex strings. Conservative: any 32+ char run that
// looks like a key is stripped.
const WALLET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
  /\b0x[0-9a-fA-F]{40,}\b/g,
];

// Curated profanity list (lowercase). The filter matches
// whole words.
const PROFANITY_LIST: ReadonlyArray<string> = ['crap', 'damn', 'heck'];

export interface FilterResult {
  readonly text: string;
  readonly filtered: boolean;
  readonly stripped: ReadonlyArray<{
    readonly kind: 'link' | 'phone' | 'email' | 'wallet' | 'profanity';
    readonly original: string;
  }>;
}

/** Apply the chat filter to a piece of text. */
export function chatFilter(text: string): FilterResult {
  if (text === '') {
    return { text, filtered: false, stripped: [] };
  }
  const stripped: Array<{
    kind: 'link' | 'phone' | 'email' | 'wallet' | 'profanity';
    original: string;
  }> = [];
  let out = text;
  for (const pattern of LINK_PATTERNS) {
    out = stripPattern(out, pattern, 'link', stripped);
  }
  for (const pattern of PHONE_PATTERNS) {
    out = stripPattern(out, pattern, 'phone', stripped);
  }
  out = stripPattern(out, EMAIL_PATTERN, 'email', stripped);
  for (const pattern of WALLET_PATTERNS) {
    out = stripPattern(out, pattern, 'wallet', stripped);
  }
  for (const word of PROFANITY_LIST) {
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi');
    out = stripPattern(out, re, 'profanity', stripped);
  }
  // Collapse multiple spaces left by the strip pass.
  out = out.replace(/  +/g, ' ').trim();
  return { text: out, filtered: stripped.length > 0, stripped };
}

/**
 * Detect a prompt-injection attempt in the user's input. The
 * system prompt is the only authoritative source; any
 * user-supplied text that tries to override the system prompt
 * is refused. The detection is conservative: if the user text
 * contains phrases that look like instructions to the model,
 * it returns true.
 */
export function detectPromptInjection(text: string): boolean {
  const lower = text.toLowerCase();
  const patterns = [
    'ignore previous',
    'ignore the above',
    'ignore the instructions',
    'forget your instructions',
    'disregard your',
    'system prompt',
    'new instructions',
    'override',
    'act as',
    'pretend to be',
  ];
  return patterns.some((p) => lower.includes(p));
}

function stripPattern(
  text: string,
  pattern: RegExp,
  kind: 'link' | 'phone' | 'email' | 'wallet' | 'profanity',
  out: Array<{ kind: typeof kind; original: string }>,
): string {
  return text.replace(pattern, (match) => {
    out.push({ kind, original: match });
    return '[redacted]';
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
