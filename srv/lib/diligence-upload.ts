/** Due-diligence upload validation with the SDK's default limits (document types, 8 MB). */
import { validateUpload, type UploadValidation } from '@odatano/dpp-sdk/upload';

export { MAX_UPLOAD_BYTES, sha256Hex, decodeBase64Upload as decodeUpload, type UploadValidation } from '@odatano/dpp-sdk/upload';

export function validateDiligenceUpload(fileName: string, mimeType: string, sizeBytes: number): UploadValidation {
    return validateUpload(fileName, mimeType, sizeBytes);
}
