import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { hashPassword, verifyPassword } from '../src/renderer/password-utils.mjs';

test('password hashes use independent salts and validate only the matching password', async () => {
  const first = await hashPassword('correct horse battery staple', webcrypto);
  const second = await hashPassword('correct horse battery staple', webcrypto);

  assert.notEqual(first, second);
  assert.deepEqual(await verifyPassword('correct horse battery staple', first, webcrypto), { valid: true, needsRehash: false });
  assert.deepEqual(await verifyPassword('incorrect password', first, webcrypto), { valid: false, needsRehash: false });
});

test('password verification supports plaintext legacy accounts for one-time migration', async () => {
  assert.deepEqual(await verifyPassword('legacy-password', 'legacy-password', webcrypto), { valid: true, needsRehash: true });
  assert.deepEqual(await verifyPassword('wrong-password', 'legacy-password', webcrypto), { valid: false, needsRehash: true });
});

test('malformed or excessive-cost hashes do not fall back to plaintext authentication', async () => {
  assert.deepEqual(await verifyPassword('pbkdf2-sha256$bad', 'pbkdf2-sha256$bad', webcrypto), { valid: false, needsRehash: false });
  assert.deepEqual(await verifyPassword('pw', 'pbkdf2-sha256$600000$A$A', webcrypto), { valid: false, needsRehash: false });
  assert.deepEqual(await verifyPassword('pw', 'pbkdf2-sha256$999999999$YWJj$YWJj', webcrypto), { valid: false, needsRehash: false });
  await assert.rejects(hashPassword('', webcrypto), /non-empty/);
});
