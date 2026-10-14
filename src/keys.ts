import { exportJWK, generateKeyPair, importJWK, importPKCS8, calculateJwkThumbprint, type JWK, type CryptoKey as JoseCryptoKey } from 'jose';
import { SigningAlg } from './constants.js';

export interface SigningKey {
  privateKey: JoseCryptoKey;
  publicKey: JoseCryptoKey;
  publicJwk: JWK;
  kid: string;
  alg: typeof SigningAlg.ES256;
}

/** Generates an ES256 key pair for the gateway to sign session tokens. Persist the exported private JWK between restarts. */
export async function generateSigningKey(): Promise<SigningKey & { privateJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair(SigningAlg.ES256, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = SigningAlg.ES256;
  publicJwk.use = 'sig';
  privateJwk.kid = kid;
  return { privateKey: privateKey as JoseCryptoKey, publicKey: publicKey as JoseCryptoKey, publicJwk, privateJwk, kid, alg: SigningAlg.ES256 };
}

/** Imports a previously exported private JWK (from generateSigningKey) or a PKCS#8 PEM. */
export async function importSigningKey(key: JWK | string): Promise<SigningKey> {
  if (typeof key === 'string') {
    const privateKey = await importPKCS8(key, SigningAlg.ES256, { extractable: true });
    const publicJwk = await exportJWK(privateKey);
    delete publicJwk.d;
    const kid = await calculateJwkThumbprint(publicJwk);
    publicJwk.kid = kid;
    publicJwk.alg = SigningAlg.ES256;
    publicJwk.use = 'sig';
    const publicKey = (await importJWK(publicJwk, SigningAlg.ES256)) as JoseCryptoKey;
    return { privateKey: privateKey as JoseCryptoKey, publicKey, publicJwk, kid, alg: SigningAlg.ES256 };
  }
  const privateKey = await importJWK(key, SigningAlg.ES256);
  const publicJwk: JWK = { ...key };
  delete publicJwk.d;
  const kid = key.kid ?? (await calculateJwkThumbprint(publicJwk));
  publicJwk.kid = kid;
  publicJwk.alg = SigningAlg.ES256;
  publicJwk.use = 'sig';
  const publicKey = (await importJWK(publicJwk, SigningAlg.ES256)) as JoseCryptoKey;
  return { privateKey: privateKey as JoseCryptoKey, publicKey, publicJwk, kid, alg: SigningAlg.ES256 };
}
