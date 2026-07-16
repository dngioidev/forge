# forge deploy scaffold — staging environment (prod-shaped, smaller sizing).
# State is remote with locking and secret-bearing: never committed, never
# sent to CLI backends (spec §10/§13).
terraform {
  required_version = ">= 1.7"

  backend "gcs" {
    bucket = "REPLACE-ME-tfstate-bucket"
    prefix = "{{APP}}/staging"
  }
}

module "observability" {
  source          = "../../modules/observability"
  app             = "{{APP}}"
  environment     = "staging"
  healthcheck_url = "REPLACE-ME-staging-url{{HEALTHCHECK}}"
}
