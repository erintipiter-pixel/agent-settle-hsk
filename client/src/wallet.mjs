// Agent wallet loading.
//
// HARD RULES:
// - The key file is read programmatically in-process ONLY. Its content is
//   never printed, logged, or included in any output.
// - Library error messages ECHO their input (ethers includes the offending
//   value in TypeError messages), so raw file content must NEVER be passed
//   to a library call. The key is extracted and strictly validated by
//   regex in-process first; only a validated 0x<64 hex> candidate reaches
//   the Wallet constructor, and any failure throws a sanitised error.
//
// Accepted file shapes: bare hex key; JSON object carrying the key under
// a conventional field name; or a labelled text card with a
// "Private key : 0x…" line (the extraction is by pattern, in-process).

import fs from 'node:fs';
import { Wallet } from 'ethers';

const KEY_FIELD_NAMES = ['privateKey', 'private_key', 'key', 'pk', 'secretKey'];
const HEX64 = /0x[0-9a-fA-F]{64}/;
const STRICT = /^0x[0-9a-fA-F]{64}$/;

function extractKey(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      for (const name of KEY_FIELD_NAMES) {
        if (typeof obj[name] === 'string' && STRICT.test(obj[name].trim())) return obj[name].trim();
      }
    } catch {
      /* fall through to pattern extraction */
    }
  }
  if (STRICT.test(trimmed)) return trimmed;
  const labelled = trimmed.match(/private\s*key\s*[:=]\s*(0x[0-9a-fA-F]{64})/i);
  if (labelled) return labelled[1];
  const bare = trimmed.match(HEX64);
  if (bare) return bare[0];
  throw new Error('no private key pattern found in key file');
}

/** Load the agent wallet (optionally connected to a provider). */
export function loadAgentWallet(keyFile, provider = null) {
  let wallet;
  try {
    const key = extractKey(fs.readFileSync(keyFile, 'utf8'));
    wallet = new Wallet(key);
  } catch {
    // Sanitised on purpose: never propagate library errors that may echo
    // file content.
    throw new Error('could not load agent wallet from key file (content withheld)');
  }
  return provider ? wallet.connect(provider) : wallet;
}
