/**
 * Validation + hashing for due-diligence evidence uploads. Pure module so the
 * rules are unit-testable without a CAP context. The bytes stay off-chain in
 * the DiligenceDoc row; only the sha256 computed here gets anchored on-chain.
 */
import { createHash } from 'node:crypto';

/** Documents only: evidence reports, audits, scans. No active content. */
const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'application/json',
    'text/plain',
    'image/png',
    'image/jpeg',
]);

/** 8 MB cap: evidence PDFs, not archives; rows travel through OData + SQLite. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface UploadValidation { ok: boolean; error?: string }

export function validateDiligenceUpload(fileName: string, mimeType: string, sizeBytes: number): UploadValidation {
    if (!fileName || fileName.length > 255) return { ok: false, error: 'fileName is required (max 255 chars)' };
    // Path fragments in a display name are always an injection attempt.
    if (/[\\/]|\.\./.test(fileName)) return { ok: false, error: 'fileName must not contain path separators' };
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        return { ok: false, error: `unsupported mimeType '${mimeType}' (allowed: ${[...ALLOWED_MIME_TYPES].join(', ')})` };
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return { ok: false, error: 'empty upload' };
    if (sizeBytes > MAX_UPLOAD_BYTES) {
        return { ok: false, error: `file exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit` };
    }
    return { ok: true };
}

/** Decode the OData-transported base64 payload; rejects malformed input. */
export function decodeUpload(contentBase64: string): Buffer | null {
    if (!contentBase64) return null;
    const normalized = contentBase64.replace(/^data:[^;]+;base64,/, '');
    try {
        const buf = Buffer.from(normalized, 'base64');
        // Re-encode round-trip guards against silently truncated garbage input.
        if (!buf.length || buf.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) return null;
        return buf;
    } catch { return null; }
}

export function sha256Hex(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}
