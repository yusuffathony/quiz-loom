const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, generateSalt, generateToken, extractBearerToken } = require('../src/auth.js');
const { MockD1 } = require('./mockD1.js');
const worker = require('../src/index.js').default;
const { app } = require('../server.js');

test('Auth crypto helpers: hash, salt, verify, and token extraction', async () => {
  const salt = generateSalt();
  assert.ok(salt && salt.length === 32, 'Salt should be 32 hex chars');

  const token = generateToken();
  assert.ok(token.startsWith('tok_'), 'Token should have tok_ prefix');

  const password = 'mySecretPassword123';
  const hash1 = await hashPassword(password, salt);
  const hash2 = await hashPassword(password, salt);
  assert.strictEqual(hash1, hash2, 'Hash must be deterministic for identical salt');

  const otherSalt = generateSalt();
  const hashOther = await hashPassword(password, otherSalt);
  assert.notStrictEqual(hash1, hashOther, 'Hash with different salt must differ');

  const isCorrect = await verifyPassword(password, salt, hash1);
  assert.strictEqual(isCorrect, true, 'Matching password must verify true');

  const isWrong = await verifyPassword('wrongPass', salt, hash1);
  assert.strictEqual(isWrong, false, 'Wrong password must verify false');

  // Token extraction
  assert.strictEqual(extractBearerToken('Bearer abc123xyz'), 'abc123xyz');
  assert.strictEqual(extractBearerToken({ headers: { authorization: 'Bearer token-in-header' } }), 'token-in-header');
  assert.strictEqual(extractBearerToken('InvalidHeader'), null);
});

test('Cloudflare Worker Auth flow: Register, Duplicate prevention, Login, /me, and Logout', async () => {
  const mockD1 = new MockD1();
  const env = { DB: mockD1 };

  // 1. Validation error on short username
  const shortUserRes = await worker.fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ab', password: 'password123' })
  }), env, {});
  assert.strictEqual(shortUserRes.status, 400);

  // 2. Successful Registration
  const regRes = await worker.fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ProfQuiz', password: 'securePassword!' })
  }), env, {});
  assert.strictEqual(regRes.status, 201);
  const regJson = await regRes.json();
  assert.strictEqual(regJson.ok, true);
  assert.strictEqual(regJson.user.username, 'ProfQuiz');
  assert.ok(regJson.token);
  const authToken = regJson.token;

  // 3. Duplicate username should be rejected
  const dupRes = await worker.fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ProfQuiz', password: 'anotherPassword' })
  }), env, {});
  assert.strictEqual(dupRes.status, 400);

  // 4. Login with incorrect password
  const badLoginRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ProfQuiz', password: 'wrongPassword' })
  }), env, {});
  assert.strictEqual(badLoginRes.status, 401);

  // 5. Login with correct password
  const loginRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ProfQuiz', password: 'securePassword!' })
  }), env, {});
  assert.strictEqual(loginRes.status, 200);
  const loginJson = await loginRes.json();
  assert.strictEqual(loginJson.ok, true);
  assert.strictEqual(loginJson.user.username, 'ProfQuiz');
  assert.ok(loginJson.token);

  // 6. Check /api/auth/me with valid Bearer token
  const meRes = await worker.fetch(new Request('http://localhost/api/auth/me', {
    headers: { 'Authorization': `Bearer ${authToken}` }
  }), env, {});
  assert.strictEqual(meRes.status, 200);
  const meJson = await meRes.json();
  assert.strictEqual(meJson.ok, true);
  assert.strictEqual(meJson.user.username, 'ProfQuiz');

  // 7. Check /api/auth/me without token -> 401
  const unauthRes = await worker.fetch(new Request('http://localhost/api/auth/me'), env, {});
  assert.strictEqual(unauthRes.status, 401);

  // 8. Logout invalidates session
  const logoutRes = await worker.fetch(new Request('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}` }
  }), env, {});
  assert.strictEqual(logoutRes.status, 200);

  // Subsequent /me call with logged-out token is rejected
  const postLogoutMe = await worker.fetch(new Request('http://localhost/api/auth/me', {
    headers: { 'Authorization': `Bearer ${authToken}` }
  }), env, {});
  assert.strictEqual(postLogoutMe.status, 401);
});
