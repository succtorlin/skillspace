'use strict';
const crypto = require('crypto');

// The per-boot API secret, and the only rules for reading it off a request.
//
// WHY IT EXISTS. The Origin / Sec-Fetch / Host checks in server.js stop a WEB
// PAGE driving the API. They cannot stop a LOCAL PROCESS: curl sends none of
// those headers and was admitted as "a non-browser client". That includes every
// agent SkillSpace itself spawns - a prompt-injected worker could register $HOME
// as a project and POST orders that run in place, outside any worktree, past
// the goal hold and the attempt budget. Every /api/* request must now prove it
// came from someone the human handed the secret to.
//
// HOW IT IS DELIVERED, and why not some easier way. Anything served to "whoever
// asks" over loopback HTTP is served to curl too, so injecting the secret into
// the console's index.html for every GET / would hand it to the very agent it
// exists to stop. The secret is therefore printed ONCE, to the terminal that
// started the server, as a link (/?auth=SECRET). Opening that link sets an
// HttpOnly, SameSite=Strict cookie and redirects to /; only a request carrying
// that cookie gets index.html, with the secret in a <meta> for the console's
// own fetches to send as a header. It is never written to disk and never put in
// process.env, so neither the child-env allowlist nor
// SKILLSPACE_ENV_PASSTHROUGH=1 can hand it to an agent.
//
// THE RESIDUAL. An agent runs as the same OS user. It cannot see the
// terminal's scrollback or the browser's cookie jar through anything this
// process gives it, but a server whose stdout is redirected into a readable log
// file has written the link there; that is the launcher's choice to make.

// A header, not a cookie, is what /api/* checks: a cross-site page cannot set
// a custom header without a preflight this server never grants, so it doubles
// as the CSRF token. The query parameter exists for EventSource, which cannot
// send headers, and is honoured on GET only.
const HEADER = 'x-skillspace-auth';
const QUERY = 'auth';

function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// Constant-time, and length-checked first because timingSafeEqual throws on a
// length mismatch. A non-string (a repeated header arrives as an array) is
// simply not a match.
function matches(candidate, secret) {
  if (typeof candidate !== 'string' || typeof secret !== 'string' || !secret) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Port-qualified: cookies are scoped by host, NOT by port, so a test server on
// 4199 and the real console on 4177 would otherwise overwrite each other's.
function cookieName(port) {
  return `skillspace_auth_${port}`;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// What an /api/* request must carry.
function apiAuthorized(req, u, secret) {
  if (matches(req.headers[HEADER], secret)) return true;
  return req.method === 'GET' && matches(u.searchParams.get(QUERY), secret);
}

// What GET / must carry to be handed the console (and the secret inside it).
function cookieAuthorized(req, port, secret) {
  return matches(readCookie(req, cookieName(port)), secret);
}

function setCookieHeader(port, secret) {
  return `${cookieName(port)}=${secret}; HttpOnly; SameSite=Strict; Path=/`;
}

module.exports = {
  HEADER, QUERY, newSecret, matches, cookieName, readCookie,
  apiAuthorized, cookieAuthorized, setCookieHeader,
};
