import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, requireIntegration } from "@/env";

/**
 * Private S3-compatible object storage. The bucket must block public access.
 * Keys are always prefixed with the org id so a key can be checked against the
 * caller's tenant before any signed URL is issued.
 */
let client: S3Client | undefined;

function s3(): S3Client {
  requireIntegration("storage");
  if (!client) {
    const e = env();
    client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE === "true",
      // Only send checksums when an operation requires them: the SDK's newer defaults add
      // x-amz-checksum-mode to presigned URLs, which several S3-compatible services reject.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: e.S3_ACCESS_KEY_ID!, secretAccessKey: e.S3_SECRET_ACCESS_KEY! },
    });
  }
  return client;
}

export type StorageArea = "documents" | "exports" | "imports";

export function objectKey(orgId: string, area: StorageArea, id: string, ext: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("invalid org id");
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error("invalid extension");
  return `org/${orgId}/${area}/${id}.${ext}`;
}

/** Throws unless `key` belongs to `orgId`. Call before every read/sign. */
export function assertKeyInOrg(orgId: string, key: string) {
  if (!key.startsWith(`org/${orgId}/`)) throw new Error("Storage key does not belong to this organisation");
}

export async function putObject(key: string, body: Buffer | Uint8Array, contentType: string) {
  await s3().send(
    new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: env().S3_ENDPOINT ? undefined : "AES256" }),
  );
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
}

/**
 * Short-lived signed GET URL. Callers must have verified the document's org and
 * the user's `document.view` permission first, and must call assertKeyInOrg.
 */
export async function signedGetUrl(orgId: string, key: string, opts: { filename?: string; inline?: boolean } = {}) {
  assertKeyInOrg(orgId, key);
  const disposition = `${opts.inline ? "inline" : "attachment"}${opts.filename ? `; filename="${opts.filename.replace(/["\\\r\n]/g, "_")}"` : ""}`;
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key, ResponseContentDisposition: disposition }), {
    expiresIn: env().SIGNED_URL_TTL_SECONDS,
  });
}
