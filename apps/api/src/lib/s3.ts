import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "./aws";
import { config } from "./config";
import { HttpError } from "./http";

// No credentials in code: the SDK's default provider chain picks up the ECS task
// role on AWS, or your SSO session locally.
function s3() {
  if (!config.s3Bucket) throw new HttpError(503, "Document storage is not configured", "storage_unavailable");
  return s3Client();
}

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Presigned POST (not PUT) so S3 itself enforces the size limit and content type. */
export function presignUpload(key: string, contentType: string) {
  return createPresignedPost(s3(), {
    Bucket: config.s3Bucket!,
    Key: key,
    Conditions: [
      ["content-length-range", 1, MAX_DOCUMENT_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: { "Content-Type": contentType },
    Expires: 300,
  });
}

export function presignDownload(key: string, fileName: string) {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: config.s3Bucket!,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.\- ]/g, "_")}"`,
    }),
    { expiresIn: 60 },
  );
}
