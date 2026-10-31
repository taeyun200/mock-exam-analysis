// 비밀번호 해시(PBKDF2-SHA256)와 세션 쿠키 서명(HMAC-SHA256). Worker와 account.js가 같이 쓴다.
const enc = s => new TextEncoder().encode(s);
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));

export async function hashPassword(pw, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey('raw', enc(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 100000 }, key, 256);
  return `${salt}:${hex(bits)}`;
}

export async function verifyPassword(pw, stored) {
  if (!stored?.includes(':')) return false;
  return await hashPassword(pw, stored.split(':')[0]) === stored;
}

export async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc(data)));
}
