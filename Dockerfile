# NIGHTPASS public demo image (see docs/public-demo.md).
#
# Serves the SAPUI5 passport viewer, the QR resolver (/p/:id, /qr/:id.png) and
# the anonymous live on-chain verification (PassportService.verifyOnChain) on
# port 4004. Runs via cds-tsx: the TypeScript service implementations need the
# tsx loader, plain cds-serve would silently skip them.
FROM node:22-slim

# Fonts + fontconfig for sharp's SVG rasterizer (per-passport OG images);
# node:22-slim ships none, and librsvg renders <text> through fontconfig.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy sources BEFORE npm ci: the postinstall step (cds-typer + connector-lib
# vite build) needs them present. Dev dependencies stay installed on purpose,
# cds-tsx / cds-typer / vite are required to build and run.
COPY . .
RUN npm ci

ENV NODE_ENV=production

EXPOSE 4004

# CAP's PostgreSQL deployer performs non-destructive schema evolution and then
# starts the application. Connection credentials arrive through the runtime
# service binding / cds_requires_db_credentials_* environment variables.
CMD ["sh", "-c", "npm run deploy && exec npx cds-tsx serve"]
