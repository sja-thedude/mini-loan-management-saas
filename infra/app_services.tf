# Same module the local emulator environment uses (infra/local), now against real AWS.
module "app" {
  source                     = "./modules/app-services"
  env                        = "prod"
  documents_cors_origins     = var.app_origins
  notification_sender        = var.notification_sender
  high_value_threshold_cents = "5000000"
  force_destroy              = true # learning project; false in a real production account
}
