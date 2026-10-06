/**
 * X (Twitter) OAuth 2.0 PKCE HTTP client (M7 #9).
 *
 * Thin fetch wrapper for the token exchange + users/me call.
 * The application is the only caller; routes inject a stub for
 * tests via dependency injection.
 */
import { XClient } from '../../application/x-link.js';

export interface XClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl?: string;
  readonly meUrl?: string;
}

export class XOAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createXClient(cfg: XClientConfig): XClient {
  const tokenUrl = cfg.tokenUrl ?? 'https://api.x.com/2/oauth2/token';
  const meUrl = cfg.meUrl ?? 'https://api.x.com/2/users/me';
  const auth = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  return {
    async exchangeCode(params) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      });
      const r = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: auth,
        },
        body: body.toString(),
      });
      if (!r.ok) {
        throw new XOAuthError(`x token ${r.status}: ${await r.text()}`, r.status);
      }
      const data = (await r.json()) as {
        access_token: string;
        refresh_token: string;
      };
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
      };
    },
    async fetchMe(accessToken: string) {
      const r = await fetch(meUrl, {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });
      if (!r.ok) {
        throw new XOAuthError(`x me ${r.status}: ${await r.text()}`, r.status);
      }
      const data = (await r.json()) as {
        data: {
          id: string;
          username: string;
          profile_image_url?: string;
        };
      };
      return {
        xUserId: data.data.id,
        xHandle: data.data.username,
        xAvatarUrl: data.data.profile_image_url ?? '',
      };
    },
  };
}
