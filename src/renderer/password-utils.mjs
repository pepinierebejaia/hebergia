const HASH_PREFIX = 'pbkdf2-sha256$';
const ITERATIONS = 600_000;
const SALT_LENGTH = 16;
const HASH_LENGTH = 32;
const MAX_ITERATIONS = 2_000_000;

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function parseHash(value) {
  if (typeof value !== 'string' || !value.startsWith(HASH_PREFIX)) return null;
  const match = /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const iterations = Number(match[1]);
  let salt;
  let expected;
  try {
    salt = fromBase64(match[2]);
    expected = fromBase64(match[3]);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS
      || salt.length !== SALT_LENGTH || expected.length !== HASH_LENGTH) return false;
  return { iterations, salt, expected };
}

async function derive(password, salt, iterations, cryptoApi) {
  const key = await cryptoApi.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await cryptoApi.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_LENGTH * 8);
  return new Uint8Array(bits);
}

export async function hashPassword(password, cryptoApi = globalThis.crypto) {
  if (typeof password !== 'string' || !password) throw new TypeError('Password must be a non-empty string.');
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure password hashing is unavailable in this environment.');
  }
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await derive(password, salt, ITERATIONS, cryptoApi);
  return `${HASH_PREFIX}${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password, storedValue, cryptoApi = globalThis.crypto) {
  if (typeof password !== 'string' || typeof storedValue !== 'string') return { valid: false, needsRehash: false };
  const parsed = parseHash(storedValue);
  if (parsed === null) return { valid: storedValue === password, needsRehash: true };
  if (!parsed || !cryptoApi?.subtle) return { valid: false, needsRehash: false };
  const actual = await derive(password, parsed.salt, parsed.iterations, cryptoApi);
  let difference = 0;
  for (let index = 0; index < parsed.expected.length; index++) difference |= actual[index] ^ parsed.expected[index];
  return { valid: difference === 0, needsRehash: parsed.iterations < ITERATIONS };
}
