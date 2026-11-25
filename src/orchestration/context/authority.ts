import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { ConstraintAuthorityError } from './types.ts';

// Private keys live here and nowhere on the object, so printing, spreading, cloning or
// proxying an authority never yields something that can sign.
const privateKeys = new WeakMap<ConstraintAuthority, KeyObject>();

function publicKeyText(key: KeyObject): string {
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * The owner's right to write constraints. Only an object returned by `create` or
 * `fromPrivateKey` can write; text, JSON and look-alike objects cannot become one.
 * Keep it on the host side and never hand it to code that runs agent output.
 */
export class ConstraintAuthority {
  /** Safe to share: readers verify every stored constraint against it. */
  readonly publicKey: string;

  private constructor(privateKey: KeyObject) {
    this.publicKey = publicKeyText(privateKey);
    privateKeys.set(this, privateKey);
    Object.freeze(this);
  }

  /** A new authority with a fresh Ed25519 key. */
  static create(): ConstraintAuthority {
    return new ConstraintAuthority(generateKeyPairSync('ed25519').privateKey);
  }

  /** Restores the authority from the PEM the owner kept from `exportPrivateKey`. */
  static fromPrivateKey(pem: string): ConstraintAuthority {
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: pem, format: 'pem' });
    } catch {
      throw new TypeError('A PKCS#8 PEM private key is required');
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('The constraint authority key must be Ed25519');
    }
    return new ConstraintAuthority(key);
  }

  /** The secret, for the owner's own protected storage. Whoever holds it can write constraints. */
  exportPrivateKey(): string {
    const key = privateKeys.get(this);
    if (!key) {
      throw new ConstraintAuthorityError('Not a constraint authority');
    }
    return key.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
}

/** Parses a public key as given to a store. */
export function readPublicKey(publicKey: unknown): KeyObject {
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]{40,200}={0,2}$/.test(publicKey)) {
    throw new TypeError('publicKey must be the base64 text of ConstraintAuthority.publicKey');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' });
  } catch {
    throw new TypeError('publicKey must be the base64 text of ConstraintAuthority.publicKey');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('publicKey must be an Ed25519 key');
  }
  return key;
}

function keyOf(authority: unknown, publicKey: string): KeyObject {
  const key = typeof authority === 'object' && authority !== null
    ? privateKeys.get(authority as ConstraintAuthority)
    : undefined;
  if (key === undefined) {
    throw new ConstraintAuthorityError('Writing a constraint requires the authority created by the owner');
  }
  if (publicKeyText(key) !== publicKey) {
    throw new ConstraintAuthorityError('This authority belongs to another constraint store');
  }
  return key;
}

/** The public key of a real authority; anything else is refused. Module-internal. */
export function publicKeyOf(authority: unknown): string {
  const key = typeof authority === 'object' && authority !== null
    ? privateKeys.get(authority as ConstraintAuthority)
    : undefined;
  if (key === undefined) {
    throw new ConstraintAuthorityError('Creating a constraint store requires the authority created by the owner');
  }
  return publicKeyText(key);
}

/** Throws unless `authority` is the real authority of the store that owns `publicKey`. Module-internal. */
export function assertAuthority(authority: unknown, publicKey: string): void {
  keyOf(authority, publicKey);
}

/** Signs for the store that owns `publicKey`; anything else is refused. Module-internal. */
export function signAs(authority: unknown, publicKey: string, payload: Buffer): Buffer {
  return sign(null, payload, keyOf(authority, publicKey));
}

export function verifies(publicKey: KeyObject, payload: Buffer, signature: Uint8Array): boolean {
  return signature.byteLength === 64 && verify(null, payload, publicKey, signature);
}
