/**
 * S/4 HTTP client shared by the bridge script (scripts/s4-bridge.mts) and the
 * producer cockpit's goods-receipt view (ProducerService.s4GoodsReceipts).
 *
 * Owns config-from-env, auth headers and the two reads (material documents,
 * product enrichment). All mapping stays in the pure sibling module
 * srv/lib/s4-material-document.ts; this module is the only place that talks
 * to the network.
 */

import fs from 'node:fs';
import {
    applyProductData,
    type ProductMaster, type S4MaterialDocumentHeader, type S4ProductData
} from './s4-material-document';

export interface S4Config {
    baseUrl: string;
    apiKey?: string;
    user?: string;
    password?: string;
    movementTypes: string[];
    top: number;
    masterPath: string;
    productLookup: boolean;
}

/** Null when S4_BASE_URL is unset: the S/4 lane is simply not configured. */
export function s4ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S4Config | null {
    const baseUrl = (env.S4_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (!baseUrl) return null;
    return {
        baseUrl,
        apiKey: env.S4_API_KEY || undefined,
        user: env.S4_USER || undefined,
        password: env.S4_PASSWORD || undefined,
        movementTypes: (env.S4_MOVEMENT_TYPES ?? '101').split(',').map(s => s.trim()).filter(Boolean),
        top: Math.max(1, Number(env.S4_TOP ?? 50) || 50),
        masterPath: env.S4_PRODUCT_MASTER ?? 'config/s4-product-master.json',
        productLookup: (env.S4_PRODUCT_LOOKUP ?? 'on') !== 'off'
    };
}

export function s4AuthHeaders(cfg: S4Config): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (cfg.apiKey) h.APIKey = cfg.apiKey;
    else if (cfg.user) h.Authorization = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password ?? ''}`).toString('base64');
    return h;
}

export async function fetchMaterialDocuments(cfg: S4Config): Promise<S4MaterialDocumentHeader[]> {
    const url = `${cfg.baseUrl}/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader`
        + `?$expand=to_MaterialDocumentItem&$orderby=MaterialDocument desc&$top=${cfg.top}&$format=json`;
    const res = await fetch(url, { headers: s4AuthHeaders(cfg), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`S/4 read failed: ${res.status} ${await res.text().then(t => t.slice(0, 300))}`);
    const body: any = await res.json();
    // V2 wraps in d.results; V4 (or a mock) uses value.
    return body?.d?.results ?? body?.value ?? [];
}

/** Best effort: null on any failure, so config values remain the fallback. */
export async function fetchProductData(cfg: S4Config, material: string): Promise<S4ProductData | null> {
    const base = `${cfg.baseUrl}/sap/opu/odata/sap/API_PRODUCT_SRV`;
    try {
        const res = await fetch(
            `${base}/A_Product('${encodeURIComponent(material)}')?$select=Product,NetWeight,GrossWeight,WeightUnit&$format=json`,
            { headers: s4AuthHeaders(cfg), signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return null;
        const p: any = (await res.json())?.d ?? null;
        if (!p) return null;
        let description: string | null = null;
        const dRes = await fetch(
            `${base}/A_ProductDescription(Product='${encodeURIComponent(material)}',Language='EN')?$format=json`,
            { headers: s4AuthHeaders(cfg), signal: AbortSignal.timeout(30_000) });
        if (dRes.ok) description = (await dRes.json())?.d?.ProductDescription ?? null;
        return { NetWeight: p.NetWeight, GrossWeight: p.GrossWeight, WeightUnit: p.WeightUnit, description };
    } catch {
        return null;
    }
}

export function loadProductMaster(cfg: S4Config): ProductMaster {
    return JSON.parse(fs.readFileSync(cfg.masterPath, 'utf8'));
}

/**
 * Overlay live S/4 product data on every configured master entry. Real master
 * data wins (see applyProductData); a failed lookup keeps configured values.
 */
export async function enrichMaster(
    cfg: S4Config,
    configured: ProductMaster,
    log?: (material: string, entry: ProductMaster[string], product: S4ProductData | null) => void
): Promise<ProductMaster> {
    if (!cfg.productLookup) return configured;
    const enriched: ProductMaster = {};
    for (const [material, entry] of Object.entries(configured)) {
        const product = await fetchProductData(cfg, material);
        enriched[material] = applyProductData(entry, product);
        log?.(material, enriched[material], product);
    }
    return enriched;
}
