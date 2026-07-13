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

// Built-in demo users. Locally the password equals the user name; on a PUBLIC
// deployment set DEMO_PASS_* so nobody can log in with the well-known defaults
// (see docs/public-demo.md). Setting the env var to a strong secret is enough;
// the user name stays the same.
const BUILTIN = {
  producer:  { pass: process.env.DEMO_PASS_PRODUCER  || 'producer',  roles: ['producer', 'authority', 'recycler'] },
  authority: { pass: process.env.DEMO_PASS_AUTHORITY || 'authority', roles: ['authority', 'recycler'] },
  recycler:  { pass: process.env.DEMO_PASS_RECYCLER  || 'recycler',  roles: ['recycler'] }
};

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
    if (b && creds.pass === b.pass) {
      req.user = new cds.User({ id: creds.user, roles: b.roles });
      return next();
    }

    // Partner login: DID/BPN + secret against the registry.
    try {
      const p = await cds.db.run(
        SELECT.one.from('passport.Partners').columns('did', 'role', 'secret').where({ did: creds.user })
      );
      if (p && creds.pass && creds.pass === p.secret) {
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
