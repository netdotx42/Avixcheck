/**
 * Content-Security-Policy for every response (applied in src/middleware.ts).
 *
 * - Scripts: self plus the Clerk Frontend API host derived from the publishable
 *   key. 'unsafe-inline' is needed for Next.js bootstrap scripts without nonces;
 *   'unsafe-eval' only in development (React refresh).
 * - Documents are previewed from short-lived signed URLs on the storage origin,
 *   so that origin is allowed for frames, images and fetches. Nothing else is.
 * - No framing of the app itself, no plugins, forms post only to self.
 */
export interface CspInput {
  nodeEnv?: string;
  clerkPublishableKey?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3ForcePathStyle?: string;
}

/** Clerk publishable keys are `pk_(test|live)_<base64("<frontend-api-host>$")>`. */
export function clerkFrontendApiHost(publishableKey?: string): string | undefined {
  const m = publishableKey?.match(/^pk_(?:test|live)_(.+)$/);
  if (!m) return undefined;
  try {
    const decoded = atob(m[1]!).replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function storageOrigin(i: CspInput): string | undefined {
  if (i.s3Endpoint) {
    try {
      const u = new URL(i.s3Endpoint);
      if (i.s3ForcePathStyle === "true" || !i.s3Bucket) return u.origin;
      return `${u.protocol}//${i.s3Bucket}.${u.host}`;
    } catch {
      return undefined;
    }
  }
  if (i.s3Bucket && i.s3Region) return `https://${i.s3Bucket}.s3.${i.s3Region}.amazonaws.com`;
  return undefined;
}

export function buildCsp(i: CspInput): string {
  const dev = i.nodeEnv !== "production";
  const clerk = clerkFrontendApiHost(i.clerkPublishableKey);
  const storage = storageOrigin(i);
  const clerkSrc = clerk ? [`https://${clerk}`] : [];
  const storageSrc = storage ? [storage] : [];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...clerkSrc, "https://challenges.cloudflare.com"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://img.clerk.com", ...storageSrc],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...clerkSrc, ...storageSrc, ...(dev ? ["ws:"] : [])],
    "frame-src": ["'self'", "https://challenges.cloudflare.com", ...storageSrc],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function cspFromEnv(): string {
  return buildCsp({
    nodeEnv: process.env.NODE_ENV,
    clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Bucket: process.env.S3_BUCKET,
    s3Region: process.env.S3_REGION,
    s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE,
  });
}
