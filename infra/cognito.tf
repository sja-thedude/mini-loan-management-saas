# Production auth option: Amazon Cognito user pool replacing the app's own bcrypt/JWT auth.
# TEMPLATE / migration path: not wired into the app yet (the API would verify Cognito JWTs via
# the pool's JWKS and read the immutable custom:tenant_id claim instead of its own token).
resource "aws_cognito_user_pool" "main" {
  name                     = "${local.name}-users"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"
  deletion_protection      = "INACTIVE" # ACTIVE in a real production account

  software_token_mfa_configuration { enabled = true }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 3
  }

  # Tenant is fixed at user creation by an admin/backend; users can never change it.
  schema {
    name                     = "tenant_id"
    attribute_data_type      = "String"
    mutable                  = false
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 36
      max_length = 36
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name                          = "${local.name}-web"
  user_pool_id                  = aws_cognito_user_pool.main.id
  generate_secret               = false # public SPA client; uses PKCE
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 7
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  read_attributes  = ["email", "custom:tenant_id"]
  write_attributes = ["email"] # NOT custom:tenant_id
}

# Groups map to app roles.
resource "aws_cognito_user_group" "admin" {
  name         = "ADMIN"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_group" "officer" {
  name         = "OFFICER"
  user_pool_id = aws_cognito_user_pool.main.id
}
