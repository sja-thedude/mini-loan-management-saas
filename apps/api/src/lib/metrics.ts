import { PutMetricDataCommand, StandardUnit } from "@aws-sdk/client-cloudwatch";
import { cloudWatch } from "./aws";
import { config } from "./config";
import { log } from "./log";

/**
 * Business metrics to CloudWatch (namespace LoanApp). Fire-and-forget: a metrics outage must
 * never fail a loan approval. Dimensions are low-cardinality on purpose (no tenantId:
 * each unique dimension combination is a separately billed custom metric on real AWS).
 */
export function putMetric(name: string, dimensions: Record<string, string>, value = 1, unit: StandardUnit = StandardUnit.Count) {
  if (!config.metricsEnabled) return;
  cloudWatch()
    .send(
      new PutMetricDataCommand({
        Namespace: "LoanApp",
        MetricData: [{ MetricName: name, Value: value, Unit: unit, Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })) }],
      }),
    )
    .catch((err) => log("warn", "metric_failed", { name, err: String(err) }));
}
