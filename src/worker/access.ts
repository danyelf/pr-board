import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Db } from './store.ts';

export interface Env {
  /** The owner's token. The board reads with it, and posts the owner's answers with it. */
  GITHUB_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  /** The client id of the Access service token that Claude's Mac-side tools present. */
  SERVICE_CLIENT_ID: string;
  DB: Db;
  ALLOW_LOCAL?: string;
}

export type Caller = 'owner' | 'claude';

// Cloudflare's signing keys are fetched on first use and then kept, so build the set once per team domain.
const remoteKeys = new Map<string, JWTVerifyGetKey>();

function keysFor(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    remoteKeys.set(teamDomain, keys);
  }
  return keys;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Who is calling: the owner (signed in through Access), Claude (the Access service token), or nobody.
 * The owner has an email in the token. Claude's token has none, only the service token's client id as common_name.
 */
export async function caller(req: Request, env: Env, getKey?: JWTVerifyGetKey): Promise<Caller | null> {
  if (env.ALLOW_LOCAL === '1' && new URL(req.url).hostname === 'localhost') {
    return req.headers.get('X-Local-Caller') === 'claude' ? 'claude' : 'owner';
  }
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getKey ?? keysFor(env.ACCESS_TEAM_DOMAIN), {
      audience: env.ACCESS_AUD,
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    });
    if (typeof payload.email === 'string') {
      // With no allowed address set, nobody is the owner. A token with an email is never Claude.
      return nonEmpty(env.ALLOWED_EMAIL) && payload.email.toLowerCase() === env.ALLOWED_EMAIL.toLowerCase() ? 'owner' : null;
    }
    // With no service client id set, nobody is Claude.
    return nonEmpty(env.SERVICE_CLIENT_ID) && payload.common_name === env.SERVICE_CLIENT_ID ? 'claude' : null;
  } catch {
    return null;
  }
}
