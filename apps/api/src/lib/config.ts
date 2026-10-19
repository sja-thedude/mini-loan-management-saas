import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { secretsManager, ssm } from "./aws";

/**
 * Runtime configuration. Sources, in order of precedence:
 *  1. Environment variables (local dev, tests).
 *  2. AWS Secrets Manager for secrets (JWT_SECRET_ID) and SSM Parameter Store for non-secret
 *     config (SSM_PREFIX), loaded once at startup by initConfig().
 */
export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? "",
  cookieSecure: process.env.COOKIE_SECURE === "true",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  s3Bucket: process.env.S3_BUCKET || undefined,
  kmsKeyId: process.env.KMS_KEY_ID || undefined,
  eventBusName: process.env.EVENT_BUS_NAME || undefined,
  metricsEnabled: process.env.METRICS_ENABLED === "true",
  highValueThresholdCents: BigInt(process.env.HIGH_VALUE_THRESHOLD_CENTS ?? "5000000"),
};

export async function initConfig() {
  if (process.env.JWT_SECRET_ID) {
    const res = await secretsManager().send(new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET_ID }));
    config.jwtSecret = res.SecretString ?? "";
  }
  if (process.env.SSM_PREFIX) {
    const res = await ssm().send(new GetParameterCommand({ Name: `${process.env.SSM_PREFIX}/high-value-threshold-cents` }));
    if (res.Parameter?.Value) config.highValueThresholdCents = BigInt(res.Parameter.Value);
  }
  assertConfig();
}

export function assertConfig() {
  if (config.jwtSecret.length < 32) throw new Error("JWT signing key missing or shorter than 32 characters");
}
