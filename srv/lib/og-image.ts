/**
 * Per-passport Open Graph preview images (1200x630), rendered server-side
 * from an SVG template via sharp. Served by GET /p/:passportId/og.png
 * (srv/server.ts); link crawlers get them through the per-passport meta page
 * the QR resolver serves on the public explorer surface.
 *
 * Anchored passports are immutable, so renders are cached per passport and
 * keyed by the attestation tx (a re-anchor invalidates naturally).
 */
import sharp from 'sharp';

export interface OgPassportData {
    passportId: string;
    model?: string | null;
    batteryCategory?: string | null;
    anchorNetwork?: string | null;
    attestationTxHash?: string | null;
    status?: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
    EV: 'Electric Vehicle battery',
    INDUSTRIAL: 'Industrial battery',
    LMT: 'Light Means of Transport battery',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ring of ticks + check mark, same motif as the site-wide OG image. */
function ringSvg(cx: number, cy: number, scale: number): string {
    const ticks = Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2 - Math.PI / 2;
        const r1 = 86 * scale, r2 = 96 * scale;
        const on = i / 48 < 0.8;
        return `<line x1="${(cx + r1 * Math.cos(a)).toFixed(1)}" y1="${(cy + r1 * Math.sin(a)).toFixed(1)}"` +
            ` x2="${(cx + r2 * Math.cos(a)).toFixed(1)}" y2="${(cy + r2 * Math.sin(a)).toFixed(1)}"` +
            ` stroke="${on ? '#7aa2ff' : '#232838'}" stroke-width="${3 * scale}" stroke-linecap="round"/>`;
    }).join('');
    return `${ticks}
      <circle cx="${cx}" cy="${cy}" r="${66 * scale}" fill="#151a26" stroke="#333a52" stroke-width="1.5"/>
      <path d="M${cx - 22 * scale} ${cy + 2 * scale} l${16 * scale} ${16 * scale} l${30 * scale} ${-34 * scale}"
            stroke="#7fd89a" stroke-width="${7.5 * scale}" fill="none" stroke-linecap="round"/>`;
}

/** One pill chip; width is estimated from the label length. */
function chip(x: number, y: number, label: string, accent = false): { svg: string; width: number } {
    const width = Math.round(label.length * 10.6) + 44;
    const fill = accent ? '#101a13' : '#161a26';
    const stroke = accent ? '#2c4a33' : '#2e3346';
    const color = accent ? '#7fd89a' : '#c7cddc';
    return {
        width,
        svg: `<rect x="${x}" y="${y}" rx="23" ry="23" width="${width}" height="46" fill="${fill}" stroke="${stroke}"/>
          <text x="${x + width / 2}" y="${y + 30}" text-anchor="middle" font-size="19" fill="${color}">${esc(label)}</text>`,
    };
}

export function buildOgSvg(p: OgPassportData): string {
    const model = p.model || p.passportId;
    const category = CATEGORY_LABEL[p.batteryCategory ?? ''] ?? p.batteryCategory ?? 'Battery';
    const anchored = p.status === 'anchored';
    const tx = (p.attestationTxHash || '').slice(0, 12);

    const chips: string[] = [];
    let cx = 96;
    const rowY = 470;
    // Deliberately no network name on the image: it stays valid across
    // preview/preprod/mainnet without per-network variants.
    const first = chip(cx, rowY, anchored ? 'anchored on Midnight' : `status: ${p.status ?? 'draft'}`, anchored);
    chips.push(first.svg); cx += first.width + 14;
    const second = chip(cx, rowY, 'EU 2023/1542');
    chips.push(second.svg); cx += second.width + 14;
    if (tx) {
        const third = chip(cx, rowY, `tx ${tx}…`);
        chips.push(third.svg);
    }

    return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg"
      font-family="DejaVu Sans, Segoe UI, Helvetica, Arial, sans-serif">
  <rect width="1200" height="630" fill="#07080c"/>
  <rect x="26" y="26" width="1148" height="578" rx="28" fill="#10121b" stroke="#2b3350" stroke-width="2"/>
  <rect x="28" y="28" width="1144" height="120" rx="26" fill="#ffffff" opacity="0.03"/>
  <circle cx="985" cy="200" r="330" fill="#7aa2ff" opacity="0.07"/>

  <text x="96" y="140" font-size="27" font-weight="bold" letter-spacing="3.5" fill="#7aa2ff">ZKPASSPORT.EU</text>
  <text x="368" y="140" font-size="19" fill="#8b93a8">by NIGHTPASS &amp; ODATANO</text>

  <text x="96" y="240" font-size="58" font-weight="bold" fill="#e8eaf2">${esc(model)}</text>
  <text x="96" y="300" font-size="27" fill="#7aa2ff" font-family="DejaVu Sans Mono, Consolas, monospace">${esc(p.passportId)}</text>

  <text x="96" y="368" font-size="25" fill="#9aa1b5">${esc(category)} · EU Digital Battery Passport</text>
  <text x="96" y="404" font-size="25" fill="#9aa1b5">Open to inspect and verify the on-chain anchor live.</text>

  ${chips.join('\n  ')}
  <g>${ringSvg(940, 320, 1.55)}</g>
</svg>`;
}

const cache = new Map<string, { key: string; png: Buffer }>();

export async function renderOgPng(p: OgPassportData): Promise<Buffer> {
    const key = `${p.attestationTxHash ?? ''}|${p.status ?? ''}|${p.model ?? ''}`;
    const hit = cache.get(p.passportId);
    if (hit && hit.key === key) return hit.png;
    const png = await sharp(Buffer.from(buildOgSvg(p))).png().toBuffer();
    if (cache.size > 200) cache.clear();
    cache.set(p.passportId, { key, png });
    return png;
}

/** Meta page for link crawlers: per-passport OG tags + instant redirect. */
export function ogMetaPage(p: OgPassportData, host: string, target: string): string {
    const title = `${p.model || p.passportId} · EU Battery Passport`;
    const desc = `Battery passport ${p.passportId}, anchored on Midnight. ` +
        'Open to inspect and verify the on-chain anchor live. No account needed.';
    const img = `${host}/p/${encodeURIComponent(p.passportId)}/og.png`;
    const url = `${host}/p/${encodeURIComponent(p.passportId)}`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="zkpassport.eu">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="theme-color" content="#0e0f13">
<link rel="canonical" href="${esc(url)}">
<script>location.replace(${JSON.stringify(target)});</script>
</head><body>
<noscript><a href="${esc(target)}">Open battery passport ${esc(p.passportId)}</a></noscript>
</body></html>`;
}
