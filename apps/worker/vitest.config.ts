import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      NOTIFICATIONS_TABLE: "loan-app-local-notifications",
      OPS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:loan-app-local-ops-alerts",
      SSM_PREFIX: "/loan-app/local",
      NODE_ENV: "test",
    },
  },
});
