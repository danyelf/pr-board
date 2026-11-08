import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Env {
  GITHUB_TOKEN: string;
  /** A token that posts comments as the owner. Without it the board shows the answer controls, but can't send. */
  GITHUB_ANSWER_TOKEN?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  ALLOW_LOCAL?: string;
}

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

export async function checkAccess(req: Request, env: Env, getKey?: JWTVerifyGetKey): Promise<boolean> {
  if (env.ALLOW_LOCAL === '1' && new URL(req.url).hostname === 'localhost') return true;
  // With no allowed address set, nobody gets in. (A token without an email must not match a missing one.)
  if (typeof env.ALLOWED_EMAIL !== 'string' || env.ALLOWED_EMAIL === '') return false;
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getKey ?? keysFor(env.ACCESS_TEAM_DOMAIN), {
      audience: env.ACCESS_AUD,
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    });
    return typeof payload.email === 'string' && payload.email.toLowerCase() === env.ALLOWED_EMAIL.toLowerCase();
  } catch {
    return false;
  }
}
