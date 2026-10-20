/** HMAC-signed DPP role tokens `bp.<role>.<uuid>.<sig>`; the secret comes from DPP_API_TOKEN_SECRET. */
import { createTokenSigner } from '@odatano/dpp-sdk/token';

// Without a configured secret the signer picks a random one per process.
const signer = createTokenSigner({ secret: process.env.DPP_API_TOKEN_SECRET, prefix: 'bp' });

export function mintDppToken(role: string): string {
    return signer.mint(role);
}

/** Role carried by a validly signed token, else undefined. */
export function roleFromSignedToken(raw: string): string | undefined {
    return signer.roleOf(raw);
}
