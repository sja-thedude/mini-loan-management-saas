import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { kms } from "./aws";
import { config } from "./config";
import { HttpError } from "./http";

/**
 * Field-level encryption of PII with AWS KMS.
 * The encryption context {tenantId, field} is authenticated data: a ciphertext copied into
 * another tenant's row (bug, SQL injection, bad migration) CANNOT be decrypted, and every
 * Decrypt is recorded in CloudTrail with that context.
 * KMS Encrypt handles up to 4 KB directly; larger data would use envelope encryption
 * (GenerateDataKey + local AES-GCM).
 */
const FIELD = "customer.nationalId";

function keyId() {
  if (!config.kmsKeyId) throw new HttpError(503, "Encryption service is not configured", "kms_unavailable");
  return config.kmsKeyId;
}

export async function encryptNationalId(tenantId: string, plaintext: string) {
  const res = await kms().send(
    new EncryptCommand({ KeyId: keyId(), Plaintext: Buffer.from(plaintext, "utf8"), EncryptionContext: { tenantId, field: FIELD } }),
  );
  return { ciphertext: Buffer.from(res.CiphertextBlob!).toString("base64"), last4: plaintext.slice(-4) };
}

export async function decryptNationalId(tenantId: string, ciphertext: string) {
  const res = await kms().send(
    new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertext, "base64"), EncryptionContext: { tenantId, field: FIELD } }),
  );
  return Buffer.from(res.Plaintext!).toString("utf8");
}
