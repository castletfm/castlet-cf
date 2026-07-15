/**
 * Turnstile Siteverify validation.
 *
 * Never log the Turnstile token or the secret key.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success?: boolean;
}

/**
 * Validates a login Turnstile token against the Siteverify endpoint.
 * Returns false on validation failure, non-2xx responses, malformed
 * responses, and network errors (fail closed).
 */
export async function verifyTurnstileToken(
  secretKey: string,
  token: string,
  remoteIp?: string,
): Promise<boolean> {
  const form = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp !== undefined) {
    form.set("remoteip", remoteIp);
  }

  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!response.ok) {
      return false;
    }
    const result = (await response.json()) as SiteverifyResponse;
    return result.success === true;
  } catch {
    return false;
  }
}
