import { readFile } from "node:fs/promises";
import path from "node:path";
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageObject } from "./backup";

/**
 * S3 helpers for backups. The document bucket is listed (never copied here:
 * enable bucket versioning + replication at the provider). Backup files go to
 * a SEPARATE bucket (BACKUP_S3_BUCKET) with its own credentials if given, so an
 * app credential leak cannot delete backups. Configure object lock / retention
 * on that bucket at the provider.
 */
function client(prefix: "S3" | "BACKUP_S3") {
  const v = (k: string) => process.env[`${prefix}_${k}`]?.trim() || (prefix === "BACKUP_S3" ? process.env[`S3_${k}`]?.trim() : undefined);
  const accessKeyId = v("ACCESS_KEY_ID");
  const secretAccessKey = v("SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey || !v("REGION")) throw new Error(`${prefix}_* credentials are not configured`);
  return new S3Client({
    region: v("REGION"),
    endpoint: v("ENDPOINT"),
    forcePathStyle: v("FORCE_PATH_STYLE") === "true",
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function documentStorageConfigured() {
  return !!(process.env.S3_BUCKET?.trim() && process.env.S3_REGION?.trim() && process.env.S3_ACCESS_KEY_ID?.trim() && process.env.S3_SECRET_ACCESS_KEY?.trim());
}

export async function listDocumentStorage(): Promise<{ bucket: string; objects: StorageObject[] }> {
  const bucket = process.env.S3_BUCKET!.trim();
  const s3 = client("S3");
  const objects: StorageObject[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "org/", ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0, etag: (o.ETag ?? "").replace(/"/g, "") });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return { bucket, objects };
}

export async function uploadBackupFiles(dir: string, files: string[]): Promise<string[]> {
  const bucket = process.env.BACKUP_S3_BUCKET?.trim();
  if (!bucket) return [];
  const s3 = client("BACKUP_S3");
  const prefix = (process.env.BACKUP_S3_PREFIX?.trim() || "avixcheck/").replace(/^\/+/, "");
  const keys: string[] = [];
  for (const f of files) {
    const key = `${prefix}${f}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: await readFile(path.join(dir, f)) }));
    keys.push(key);
  }
  return keys;
}
