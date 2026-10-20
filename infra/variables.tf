variable "region" {
  description = "The account is a single-Region project: only eu-north-1 (Stockholm) is enabled"
  type        = string
  default     = "eu-north-1"
}

variable "alert_email" {
  description = "Where AWS Budgets sends spending alerts"
  type        = string
}

variable "monthly_budget_usd" {
  type    = number
  default = 5
}

variable "allowed_cidr" {
  description = "Your public IP as x.x.x.x/32. Only this address can reach the app (no load balancer in front)."
  type        = string
}

variable "desired_count" {
  description = "Initial number of app tasks (0 = not running, no compute cost). Changed at runtime by scripts/app.sh."
  type        = number
  default     = 0
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL version; scale-to-zero needs 16.3+"
  type        = string
  default     = "16.9"
}

variable "auto_stop_cron" {
  description = "When the nightly schedule scales the app to 0 (UTC). Default 20:00 UTC = 23:00 Riyadh."
  type        = string
  default     = "cron(0 20 * * ? *)"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "app_origins" {
  description = "Browser origins of the web app (S3 CORS for direct document uploads)"
  type        = list(string)
  default     = ["*"] # demo task IP changes on every start; the presigned POST policy is what authorizes uploads
}

variable "notification_sender" {
  description = "SES-verified sender address (SES starts in sandbox: verified recipients only)"
  type        = string
  default     = "no-reply@loan-app.example"
}
