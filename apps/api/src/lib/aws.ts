import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";

/**
 * One lazily-created client per service. Credentials and endpoint come from the SDK's default
 * chain: the ECS task role / Lambda role on AWS, your SSO session locally, and
 * AWS_ENDPOINT_URL=http://localhost:4566 to point everything at the local emulator.
 */
const region = () => process.env.AWS_REGION ?? "us-east-1";
const memo = <T>(make: () => T) => {
  let c: T | undefined;
  return () => (c ??= make());
};

export const kms = memo(() => new KMSClient({ region: region() }));
export const eventBridge = memo(() => new EventBridgeClient({ region: region() }));
export const ssm = memo(() => new SSMClient({ region: region() }));
export const secretsManager = memo(() => new SecretsManagerClient({ region: region() }));
export const cloudWatch = memo(() => new CloudWatchClient({ region: region() }));
// Path-style URLs are required by S3 emulators (and harmless against real S3 for this use).
export const s3Client = memo(() => new S3Client({ region: region(), forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL) }));
