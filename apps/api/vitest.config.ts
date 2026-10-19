import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    fileParallelism: false,
    env: {
      DATABASE_URL: "postgresql://loan_app:loan_app_local_only@localhost:5433/loans_test",
      JWT_SECRET: "test-secret-test-secret-test-secret-123",
      COOKIE_SECURE: "false",
      NODE_ENV: "test",
      // Local AWS emulator (moto on :4566), provisioned by `npm run aws:bootstrap`.
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      KMS_KEY_ID: "alias/loan-app-local",
      S3_BUCKET: "loan-app-local-documents",
      EVENT_BUS_NAME: "loan-app-local-events",
      // Used by the worker handler in the end-to-end test.
      NOTIFICATIONS_TABLE: "loan-app-local-notifications",
      OPS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:loan-app-local-ops-alerts",
      SSM_PREFIX: "/loan-app/local",
    },
  },
});
