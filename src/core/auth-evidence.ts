import type { AuthStatus } from '../public/types.js';

/** Explicit negative or passive evidence cannot attest a successful login. */
export function authenticationState(auth: AuthStatus): 'authenticated' | 'not-authenticated' | 'unknown' {
  if (auth.state === 'not-authenticated') return 'not-authenticated';
  if (auth.state === 'unknown' || auth.evidence === 'local-configuration') return 'unknown';
  return auth.authenticated ? 'authenticated' : 'not-authenticated';
}

/** Boolean-only legacy adapters retain their confirmed-authentication semantics. */
export function isAuthenticationConfirmed(auth: AuthStatus): boolean {
  return authenticationState(auth) === 'authenticated';
}

export function hasConfirmedSubscription(auth: AuthStatus): boolean {
  return isAuthenticationConfirmed(auth) && auth.source === 'subscription';
}
