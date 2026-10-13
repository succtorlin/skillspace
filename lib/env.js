'use strict';

// The environment variables any process SkillSpace starts may inherit without
// being named for it. Agents get these plus their own provider's prefixes
// (server.js childEnv); SkillSpace's own git gets these plus the switches in
// lib/git.js. One list, so the two cannot drift: process.env on a developer
// machine carries AWS, GitHub, Stripe and npm tokens, and neither an agent nor
// a git that an agent can reconfigure has any business holding them.
const ENV_BASE = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ']);

function baseEnv() {
  const out = {};
  for (const k of ENV_BASE) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}

module.exports = { ENV_BASE, baseEnv };
