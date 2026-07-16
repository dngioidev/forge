# forge deploy scaffold — production environment.
terraform {
  required_version = ">= 1.7"

  backend "gcs" {
    bucket = "REPLACE-ME-tfstate-bucket"
    prefix = "{{APP}}/production"
  }
}

module "observability" {
  source          = "../../modules/observability"
  app             = "{{APP}}"
  environment     = "production"
  healthcheck_url = "REPLACE-ME-production-url{{HEALTHCHECK}}"
}
