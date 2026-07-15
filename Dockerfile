# check=skip=SecretsUsedInArgOrEnv
# The skipped check is a false positive: cds_requires_db_credentials_url is
# CAP's env mapping for cds.requires.db.credentials.url and holds a SQLite
# file path, not a secret. The variable name is fixed by CAP's convention.

# NIGHTPASS public demo image (see docs/public-demo.md).
#
# Serves the SAPUI5 passport viewer, the QR resolver (/p/:id, /qr/:id.png) and
# the anonymous live on-chain verification (PassportService.verifyOnChain) on
# port 4004. Runs via cds-tsx: the TypeScript service implementations need the
# tsx loader, plain cds-serve would silently skip them.
FROM node:22-slim

WORKDIR /app

# Copy sources BEFORE npm ci: the postinstall step (cds-typer + connector-lib
# vite build) needs them present. Dev dependencies stay installed on purpose,
# cds-tsx / cds-typer / vite are required to build and run.
COPY . .
RUN npm ci

# The runtime database lives at /data, NOT the repo default db/passport.db:
# mounting a volume over /app/db would shadow the CDS model files (db/*.cds)
# that live next to it. /data holds only the SQLite file.
ENV NODE_ENV=production \
    cds_requires_db_credentials_url=/data/passport.db
RUN mkdir -p /data

EXPOSE 4004

# Deploy a fresh schema + CSV seeds at startup when no database is present.
# Mount a volume at /data (optionally pre-loaded with an anchored passport.db)
# to persist passports across restarts; see docs/public-demo.md.
CMD ["sh", "-c", "test -f /data/passport.db || npm run deploy; exec npx cds-tsx serve"]
