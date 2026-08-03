const cds = require('@sap/cds');

/**
 * Custom CAP authentication (a realistic, mocked login).
 *
 * HTTP Basic → a principal identity, mirroring the Catena-X SSI shape:
 *   - Dataspace partners log in with their DID/BPN + secret (validated against
 *     the `passport.Partners` registry). `req.user.id = DID`, which is exactly
 *     what the read gate resolves against (midnight.GranteeIdentities.userId).
 *   - Built-in demo users (producer / recycler / authority, password = name)
 *     keep the cockpit + viewer flows working.
 *   - Anything else → anonymous (public consumer tier).
 *
 * Trust-based (no cryptographic proof the caller owns the DID). The real
 * dataspace does this with verifiable credentials; we mirror its shape.
 */
const { SELECT } = cds.ql;
const crypto = require('node:crypto');

// Built-in demo users. Locally the password equals the user name; on a PUBLIC
// deployment set DEMO_PASS_* so nobody can log in with the well-known defaults
// (see docs/public-demo.md). Setting the env var to a strong secret is enough;
// the user name stays the same.
//
// On a public host an unset DEMO_PASS_* is not a convenience, it is 'producer'
// as the password for the role that owns every write action. Such a user is
// DROPPED entirely rather than silently kept: better a login that does not
// exist than one the whole internet knows.
const IS_PUBLIC = !!process.env.PASSPORT_PUBLIC_SURFACE?.trim() || process.env.NODE_ENV === 'production';

function builtinUser(name, envPass, roles) {
  if (envPass) return { pass: envPass, roles };
  if (IS_PUBLIC) {
    console.error(`[auth] built-in user '${name}' DISABLED: set DEMO_PASS_${name.toUpperCase()} on a public deployment`);
    return null;
  }
  return { pass: name, roles };
}

const BUILTIN = Object.fromEntries(Object.entries({
  producer:  builtinUser('producer',  process.env.DEMO_PASS_PRODUCER,  ['producer', 'authority', 'recycler']),
  authority: builtinUser('authority', process.env.DEMO_PASS_AUTHORITY, ['authority', 'recycler']),
  recycler:  builtinUser('recycler',  process.env.DEMO_PASS_RECYCLER,  ['recycler'])
}).filter(([, v]) => v));

/**
 * Constant-time secret comparison. A plain `===` leaks the length of the
 * matching prefix through its timing, which is exactly the signal an attacker
 * needs to guess a partner secret character by character.
 */
function secretEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the mismatch-length case is not the fast path.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function decodeBasic(header) {
  if (!header || !/^basic /i.test(header)) return null;
  try {
    const dec = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    return i < 0 ? { user: dec, pass: '' } : { user: dec.slice(0, i), pass: dec.slice(i + 1) };
  } catch { return null; }
}

module.exports = async function (req, res, next) {
  try {
    const creds = decodeBasic(req.headers.authorization);
    if (!creds || !creds.user) { req.user = new cds.User.Anonymous(); return next(); }

    // Built-in demo users.
    const b = BUILTIN[creds.user];
    if (b && secretEquals(creds.pass, b.pass)) {
      req.user = new cds.User({ id: creds.user, roles: b.roles });
      return next();
    }

    // Partner login: DID/BPN + secret against the registry.
    try {
      const p = await cds.db.run(
        SELECT.one.from('passport.Partners').columns('did', 'role', 'secret').where({ did: creds.user })
      );
      if (p && creds.pass && secretEquals(creds.pass, p.secret)) {
        // A partner gets ONLY the 'partner' marker role (no recycler/authority):
        // their per-passport disclosure is driven purely by the grant LEVEL, so
        // they see nothing until granted, then exactly the granted tier.
        req.user = new cds.User({ id: p.did, roles: ['partner'] });
        return next();
      }
    } catch { /* db not ready / no partner → anonymous */ }

    req.user = new cds.User.Anonymous();
    return next();
  } catch {
    req.user = new cds.User.Anonymous();
    return next();
  }
};
