import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Env {
  GITHUB_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  ALLOW_LOCAL?: string;
}

export async function checkAccess(req: Request, env: Env, getKey?: JWTVerifyGetKey): Promise<boolean> {
  if (env.ALLOW_LOCAL === '1' && new URL(req.url).hostname === 'localhost') return true;
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  try {
    const keys = getKey ?? createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, keys, {
      audience: env.ACCESS_AUD,
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    });
    return payload.email === env.ALLOWED_EMAIL;
  } catch {
    return false;
  }
}
