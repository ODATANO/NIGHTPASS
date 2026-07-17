/**
 * BatteryPass-Ready conformance surface: the DPP Life Cycle API v1.1 plus the
 * TestAdapter (TestSetup/TestTeardown) the official test executor drives.
 * Specs: the OpenAPI documents published by the test environment
 * (batterypass-ready.gefeg.com) for the Economic Operator and TestAdapter.
 *
 * Mounted by srv/server.ts ONLY when DPP_API_ENABLED=true. State lives in the
 * in-memory DppStore (srv/lib/dpp-store.ts): the executor seeds every scenario
 * via TestSetup and resets via TestTeardown, so nothing here touches the
 * passport database.
 *
 * Auth model: a request without a token acts as the economic operator (full
 * read/write). TestSetup's issueCredentials mints role tokens (public /
 * legitimate_interest / authority / commission); token'd requests are
 * read-only and their reads are filtered by the longlist access classes
 * (GUIDE_ACCESS), the same classification the PassportService tier gate uses.
 */
import express from 'express';
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import {
    DppStore, DppRole, DppVersion, filterDocumentForRole, mergePatch, splitElementPath,
    getElement, patchElement, operatorIdOf, touchLastUpdate,
} from './dpp-store';
import { buildGuideDocument, guideDppId } from './guide-document';

const { SELECT, INSERT, DELETE } = cds.ql;

// 'economic_operator' is issuable too but grants operator (unfiltered, write)
// access instead of a read-only disclosure tier.
const READ_ROLES: DppRole[] = ['public', 'legitimate_interest', 'authority', 'commission'];
const ALL_ROLES = [...READ_ROLES, 'economic_operator'];

interface ExternalService { serviceType: string; serviceURL: string; auth?: { type?: string; token?: string } }

/** TestSetup command data arrives in mixed key spellings (dpP_ID vs DPP_ID). */
function pick(data: Record<string, unknown> | undefined, ...names: string[]): unknown {
    if (!data) return undefined;
    const lower = new Map(Object.keys(data).map((k) => [k.toLowerCase(), k]));
    for (const n of names) {
        const k = lower.get(n.toLowerCase());
        if (k !== undefined && data[k] !== undefined && data[k] !== '') return data[k];
    }
    return undefined;
}

export function createDppApiRouter(): express.Router {
    const store = new DppStore();
    const tokens = new Map<string, string>();
    const backupIds = new Map<string, string>(); // our dppId -> id at the Backup Provider
    let externalServices: ExternalService[] = [];

    const router = express.Router();
    router.use(express.json({ limit: '2mb', type: ['application/json', 'application/merge-patch+json'] }));

    // ---- Persistence (passport_DppDocuments) ------------------------------
    // The in-memory store is the source of truth per process; every mutation
    // is mirrored to the DppDocuments table and the store is rehydrated from
    // it on the first request after boot. Failures degrade to memory-only.

    let hydrated = false;
    async function ensureHydrated(): Promise<void> {
        if (hydrated) return;
        hydrated = true;
        try {
            const rows = await cds.run(SELECT.from('passport.DppDocuments').orderBy('dppId', 'version')) as any[];
            for (const r of rows) {
                store.loadVersion({
                    dppId: r.dppId, productId: r.productId, version: r.version,
                    status: r.status, document: JSON.parse(r.document), validFrom: r.validFrom,
                });
            }
            if (rows.length) console.log(`[dpp-api] rehydrated ${rows.length} DPP version(s)`);
        } catch (e) {
            console.warn('[dpp-api] hydration skipped:', (e as Error).message);
        }
    }
    router.use((_req, _res, next) => { ensureHydrated().then(() => next(), () => next()); });

    /** Mirror one new version row; duplicate (dppId, version) is a no-op. */
    async function persistVersion(row: DppVersion): Promise<void> {
        try {
            await cds.run(INSERT.into('passport.DppDocuments').entries({
                ID: randomUUID(), dppId: row.dppId, productId: row.productId, version: row.version,
                status: row.status, document: JSON.stringify(row.document), validFrom: row.validFrom,
            }));
        } catch { /* unique(dppId,version) conflict or no DB: memory-only */ }
    }

    /** Mirror a chain replacement (fresh insert of an explicit dppId). */
    async function persistReplace(row: DppVersion): Promise<void> {
        try { await cds.run(DELETE.from('passport.DppDocuments').where({ dppId: row.dppId })); } catch { /* no rows */ }
        await persistVersion(row);
    }

    // ---- Read-through to real anchored passports --------------------------

    /**
     * Resolve a dppId/productId to a REAL anchored NIGHTPASS passport and
     * render it as a guide document. Accepts the urn:odatano wrappers or the
     * bare passportId. Draft/failed passports stay invisible here.
     */
    async function resolveReal(id: string): Promise<{ passportId: string; document: unknown; createdAt?: string } | undefined> {
        const pid = id.replace(/^urn:odatano:(passport|battery):/, '');
        try {
            const p = await cds.run(SELECT.one.from('passport.Passports').where({ passportId: pid, status: 'anchored' })) as any;
            if (!p) return undefined;
            const [batteries, recycled, attrs] = await Promise.all([
                cds.run(SELECT.from('passport.Batteries').where({ passport_ID: p.ID })),
                cds.run(SELECT.from('passport.RecycledMaterials').where({ passport_ID: p.ID })),
                cds.run(SELECT.from('passport.PassportAttributes').where({ passport_ID: p.ID })),
            ]) as any[][];
            return { passportId: pid, document: buildGuideDocument(p, batteries, recycled, attrs), createdAt: p.createdAt };
        } catch {
            return undefined;
        }
    }

    /** Current document for a dppId: conformance store first, then anchored passports. */
    async function resolveDoc(dppId: string): Promise<unknown | undefined> {
        return store.current(dppId)?.document ?? (await resolveReal(dppId))?.document;
    }

    /** 400 for writes addressing an anchored passport (immutable via this surface). */
    async function rejectRealWrite(dppId: string, res: express.Response): Promise<boolean> {
        if (!(await resolveReal(dppId))) return false;
        fail(res, 400, 'Anchored NIGHTPASS passports are immutable through the DPP API; updates go through the producer flow and create a new on-chain anchored version');
        return true;
    }

    /** Error body per the spec's Result/Message schema. */
    const fail = (res: express.Response, status: number, text: string) =>
        res.status(status).json({ message: [{ messageType: 'Error', text, timestamp: new Date().toISOString() }] });

    /**
     * Resolve the caller. No token or an 'economic_operator' credential acts
     * as the operator (full read/write); the four read roles get read-only,
     * filtered access. Unknown tokens are rejected.
     */
    const roleOf = (req: express.Request): { role: DppRole | null; invalid: boolean } => {
        const header = String(req.headers.authorization ?? '');
        const raw = header.replace(/^(Bearer|ApiKey)\s+/i, '').trim()
            || String(req.headers['x-api-key'] ?? '').trim();
        if (!raw) return { role: null, invalid: false };
        // Tokens are self-describing (bp.<role>.<uuid>) so a restart between
        // TestSetup and the scenario run does not invalidate them.
        const resolved = tokens.get(raw) ?? /^bp\.([a-z_]+)\./.exec(raw)?.[1];
        if (resolved === 'economic_operator') return { role: null, invalid: false };
        if (resolved && (READ_ROLES as string[]).includes(resolved)) {
            return { role: resolved as DppRole, invalid: false };
        }
        return { role: null, invalid: true };
    };

    /**
     * Write guard: only the operator may create/update/delete. Denials are
     * 401 (the executor's expected-values enum knows 'Unauthorized', not
     * 'Forbidden').
     */
    const writeGuard = (req: express.Request, res: express.Response): boolean => {
        const { role, invalid } = roleOf(req);
        if (invalid) { fail(res, 401, 'Unknown or invalid credential'); return false; }
        if (role) { fail(res, 401, `Role '${role}' has no update permission`); return false; }
        return true;
    };

    /** Read view of a document for the caller (operator sees everything). */
    const view = (req: express.Request, doc: unknown): unknown => {
        const { role } = roleOf(req);
        return role ? filterDocumentForRole(doc, role) : doc;
    };

    // ---- TestAdapter ------------------------------------------------------

    router.put('/adapter/TestSetup', async (req, res) => {
        const body = (req.body ?? {}) as { commands?: unknown[]; externalServices?: ExternalService[] };
        if (Array.isArray(body.externalServices)) externalServices = body.externalServices;
        const results: unknown[] = [];
        for (const cmd of body.commands ?? []) {
            const c = cmd as { name?: string; data?: Record<string, unknown> };
            try {
                if (c.name === 'insertBatteryPass') {
                    const raw = pick(c.data, 'dpp', 'DPP');
                    const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    const row = store.insert({
                        dppId: pick(c.data, 'dpP_ID', 'DPP_ID', 'dppId') as string | undefined,
                        productId: pick(c.data, 'product_ID', 'Product_ID', 'productId') as string | undefined,
                        status: pick(c.data, 'status', 'Status') as string | undefined,
                        document: doc,
                    });
                    await persistReplace(row);
                    results.push({ name: 'insertBatteryPass', data: { success: true } });
                } else if (c.name === 'bringBatteryToMarket') {
                    const productId = String(pick(c.data, 'product_ID', 'Product_ID', 'productId') ?? '');
                    const row = store.activateByProduct(productId);
                    let ok = !!row;
                    if (row) {
                        await persistVersion(row);
                        const errors = await marketDpp(row.dppId, row.productId, row.document);
                        ok = errors.length === 0;
                        if (!ok) console.warn('[dpp-api] bringBatteryToMarket propagation:', errors.join('; '));
                    }
                    results.push({ name: 'bringBatteryToMarket', data: { success: ok } });
                } else if (c.name === 'issueCredentials') {
                    const role = String(pick(c.data, 'role') ?? 'public');
                    const type = String(pick(c.data, 'type') ?? 'apiKey');
                    if (!ALL_ROLES.includes(role)) {
                        results.push({ name: 'issueCredentials', data: { success: false } });
                        continue;
                    }
                    const token = `bp.${role}.${randomUUID()}`;
                    tokens.set(token, role);
                    results.push({ name: 'issueCredentials', data: { success: true, type, token, role } });
                } else {
                    results.push({ name: String(c.name ?? 'unknown'), data: { success: false } });
                }
            } catch {
                results.push({ name: String(c.name ?? 'unknown'), data: { success: false } });
            }
        }
        res.status(200).json({ commandResults: results });
    });

    router.put('/adapter/TestTeardown', async (_req, res) => {
        store.clear();
        tokens.clear();
        backupIds.clear();
        externalServices = [];
        try { await cds.run(DELETE.from('passport.DppDocuments')); } catch { /* memory-only */ }
        res.status(200).end();
    });

    /**
     * Place a DPP on the market: back it up at the Backup Provider (POST
     * /dpps there returns the backup's DPP id), then register product, backup
     * and operator ids in the EU Registry (POST /registerDPP). Both service
     * URLs arrive via TestSetup externalServices. Returns human-readable
     * errors; an empty array means fully propagated (or nothing announced).
     */
    async function marketDpp(dppId: string, productId: string, doc: unknown): Promise<string[]> {
        const errors: string[] = [];
        const backup = externalServices.find((s) => s.serviceType === 'Backup');
        const registry = externalServices.find((s) => s.serviceType === 'Registry');
        if (backup) {
            const r = await callService(backup, 'POST', '/dpps', doc);
            if (r.ok) backupIds.set(dppId, String(r.body ?? ''));
            else errors.push(`Backup ${r.error}`);
        }
        if (registry) {
            const r = await callService(registry, 'POST', '/registerDPP', {
                Product_ID: productId,
                Backup_ID: backupIds.get(dppId) ?? '',
                Operator_ID: operatorIdOf(doc) ?? 'EORI-DE-CELLCO-001',
            });
            if (!r.ok) errors.push(`Registry ${r.error}`);
        }
        return errors;
    }

    /** Propagate an updated document to the Backup Provider (update flows). */
    async function backupUpdate(dppId: string, doc: unknown): Promise<void> {
        const backup = externalServices.find((s) => s.serviceType === 'Backup');
        if (!backup) return;
        const known = backupIds.get(dppId);
        const r = known
            ? await callService(backup, 'PATCH', `/dpps/${encodeURIComponent(known)}`, doc)
            : await callService(backup, 'POST', '/dpps', doc);
        if (r.ok && !known) backupIds.set(dppId, String(r.body ?? ''));
        if (!r.ok) console.warn(`[dpp-api] backup propagation failed for ${dppId}: ${r.error}`);
    }

    // ---- DPP Life Cycle API v1.1 -----------------------------------------

    router.post('/v1/dpps', async (req, res) => {
        if (!writeGuard(req, res)) return;
        const doc = req.body;
        if (!doc || typeof doc !== 'object') return fail(res, 400, 'Request body must be a DPP JSON object');
        const row = store.insert({ document: touchLastUpdate(doc) });
        await persistReplace(row);
        const pushErrors = await marketDpp(row.dppId, row.productId, row.document);
        if (pushErrors.length) return fail(res, 400, `DPP stored but propagation failed: ${pushErrors.join('; ')}`);
        res.status(201).json(row.dppId);
    });

    router.get('/v1/dpps/:dppId', async (req, res) => {
        if (roleOf(req).invalid) return fail(res, 401, 'Unknown or invalid credential');
        const doc = await resolveDoc(req.params.dppId);
        if (doc === undefined) return res.status(404).end();
        res.status(200).json(view(req, doc));
    });

    /**
     * NIGHTPASS extension (not part of the DPP Life Cycle API spec): live
     * on-chain verification of the served passport. Anchored passports go
     * through PassportService.verifyOnChain (crawler-free Midnight indexer
     * read); conformance-store documents honestly report "not anchored".
     */
    router.get('/v1/dpps/:dppId/verification', async (req, res) => {
        if (roleOf(req).invalid) return fail(res, 401, 'Unknown or invalid credential');
        const real = await resolveReal(req.params.dppId);
        if (real) {
            try {
                const ps = await cds.connect.to('PassportService');
                const v = await (ps as any).send('verifyOnChain', { passportId: real.passportId });
                return res.status(200).json({ source: 'nightpass-anchored', passportId: real.passportId, ...v });
            } catch (e) {
                return res.status(200).json({ source: 'nightpass-anchored', passportId: real.passportId, verified: false, error: (e as Error).message });
            }
        }
        const row = store.current(req.params.dppId);
        if (!row) return res.status(404).end();
        res.status(200).json({ source: 'conformance-store', verified: false, anchored: false, reason: 'Test/scenario document; not anchored on Midnight' });
    });

    router.patch('/v1/dpps/:dppId', async (req, res) => {
        if (!writeGuard(req, res)) return;
        const row = store.current(req.params.dppId);
        if (!row) {
            if (await rejectRealWrite(req.params.dppId, res)) return;
            return res.status(404).end();
        }
        if (!req.body || typeof req.body !== 'object') return fail(res, 400, 'Merge patch body required');
        const updated = store.update(req.params.dppId, touchLastUpdate(mergePatch(row.document, req.body)));
        await persistVersion(updated!);
        await backupUpdate(req.params.dppId, updated!.document);
        res.status(200).json(updated!.document);
    });

    router.delete('/v1/dpps/:dppId', async (req, res) => {
        if (!writeGuard(req, res)) return;
        const row = store.delete(req.params.dppId);
        if (!row) {
            if (await rejectRealWrite(req.params.dppId, res)) return;
            return res.status(404).end();
        }
        await persistVersion(row);
        res.status(200).end();
    });

    router.get('/v1/dpps/:dppId/collections/:elementId', async (req, res) => {
        if (roleOf(req).invalid) return fail(res, 401, 'Unknown or invalid credential');
        const doc = await resolveDoc(req.params.dppId);
        if (doc === undefined) return res.status(404).end();
        const el = getElement(doc, splitElementPath(req.params.elementId));
        if (el === undefined) return res.status(404).end();
        res.status(200).json(view(req, el));
    });

    router.patch('/v1/dpps/:dppId/collections/:elementId', async (req, res) => {
        if (!writeGuard(req, res)) return;
        const row = store.current(req.params.dppId);
        if (!row) {
            if (await rejectRealWrite(req.params.dppId, res)) return;
            return res.status(404).end();
        }
        const parts = splitElementPath(req.params.elementId);
        if (getElement(row.document, parts) === undefined) return res.status(404).end();
        if (!req.body || typeof req.body !== 'object') return fail(res, 400, 'Merge patch body required');
        const updated = store.update(req.params.dppId, touchLastUpdate(patchElement(row.document, parts, req.body)));
        await persistVersion(updated!);
        await backupUpdate(req.params.dppId, updated!.document);
        res.status(200).json(getElement(updated!.document, parts));
    });

    router.get('/v1/dpps/:dppId/elements/:elementPath', async (req, res) => {
        if (roleOf(req).invalid) return fail(res, 401, 'Unknown or invalid credential');
        const doc = await resolveDoc(req.params.dppId);
        if (doc === undefined) return res.status(404).end();
        const parts = splitElementPath(req.params.elementPath);
        const el = getElement(doc, parts);
        if (el === undefined) return res.status(404).end();
        // The element is served wrapped in its attribute name (the executor's
        // reference files are {"<Attribute>": <value>} fragments).
        const leaf = parts[parts.length - 1];
        // A role that may not see the leaf attribute gets a 404, not a leak.
        const { role } = roleOf(req);
        if (role) {
            const filtered = getElement(filterDocumentForRole(doc, role), parts);
            if (filtered === undefined) return res.status(404).end();
            return res.status(200).json({ [leaf]: filtered });
        }
        res.status(200).json({ [leaf]: el });
    });

    router.patch('/v1/dpps/:dppId/elements/:elementPath', async (req, res) => {
        if (!writeGuard(req, res)) return;
        const row = store.current(req.params.dppId);
        if (!row) {
            if (await rejectRealWrite(req.params.dppId, res)) return;
            return res.status(404).end();
        }
        const parts = splitElementPath(req.params.elementPath);
        if (req.body === undefined) return fail(res, 400, 'Patch body required');
        const updated = store.update(req.params.dppId, touchLastUpdate(patchElement(row.document, parts, req.body)));
        await persistVersion(updated!);
        await backupUpdate(req.params.dppId, updated!.document);
        res.status(200).json(getElement(updated!.document, parts));
    });

    router.get('/v1/dppsByProductId/:productId', async (req, res) => {
        if (roleOf(req).invalid) return fail(res, 401, 'Unknown or invalid credential');
        const row = store.activeByProduct(req.params.productId);
        const doc = row?.document ?? (await resolveReal(req.params.productId))?.document;
        if (doc === undefined) return res.status(404).end();
        res.status(200).json(view(req, doc));
    });

    router.get('/v1/dppsByProductIdAndDate/:productId', async (req, res) => {
        if (roleOf(req).invalid) return fail(res, 401, 'Unknown or invalid credential');
        const date = String(req.query.date ?? '');
        if (!date) return fail(res, 400, 'Query parameter `date` is required');
        const row = store.byProductAndDate(req.params.productId, date);
        if (row) return res.status(200).json(view(req, row.document));
        // Anchored passports have a single served version, current since creation.
        const real = await resolveReal(req.params.productId);
        if (real?.createdAt && Date.parse(real.createdAt) <= Date.parse(date)) {
            return res.status(200).json(view(req, real.document));
        }
        res.status(404).end();
    });

    router.post('/v1/dppsByProductIds', async (req, res) => {
        if (roleOf(req).invalid) return fail(res, 401, 'Unknown or invalid credential');
        const ids = Array.isArray(req.body) ? req.body.map(String) : null;
        if (!ids) return fail(res, 400, 'Request body must be an array of product ids');
        const out: string[] = [];
        for (const productId of ids) {
            const row = store.activeByProduct(productId);
            if (row) { out.push(row.dppId); continue; }
            const real = await resolveReal(productId);
            if (real) out.push(guideDppId(real.passportId));
        }
        res.status(200).json(out);
    });

    return router;
}

/** One HTTP call to an announced external service (Backup/Registry). */
async function callService(
    svc: ExternalService, method: string, path: string, body: unknown,
): Promise<{ ok: boolean; body?: unknown; error?: string }> {
    try {
        const base = svc.serviceURL.replace(/\/+$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (svc.auth?.token) headers.Authorization = `${svc.auth.type || 'Bearer'} ${svc.auth.token}`;
        const res = await fetch(`${base}${path}`, {
            method, headers, body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { ok: false, error: `${res.status} at ${path}` };
        const text = await res.text();
        try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: true, body: text }; }
    } catch (e) {
        return { ok: false, error: `unreachable (${(e as Error).message})` };
    }
}
