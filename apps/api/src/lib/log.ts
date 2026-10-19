// One JSON object per line on stdout. On ECS the awslogs driver ships stdout to
// CloudWatch Logs, where Logs Insights can filter on these fields.
type Level = "info" | "warn" | "error";

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === "test" && level === "info") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === "error" ? console.error : console.log)(line);
}
