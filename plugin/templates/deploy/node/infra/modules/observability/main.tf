# forge observability minimum (spec §10): uptime check + error alert +
# cloud budget alert per environment — an incident pages the deploy approver
# instead of waiting for a user report. GCP reference implementation; swap the
# resources for your provider, keep the three signals.
variable "app" { type = string }
variable "environment" { type = string }
variable "healthcheck_url" { type = string }

# 1. Uptime check against the environment's healthcheck
# resource "google_monitoring_uptime_check_config" "health" { … }

# 2. Log-based error alert
# resource "google_monitoring_alert_policy" "errors" { … }

# 3. Budget alert — a cost anomaly is an incident signal (spec §10)
# resource "google_billing_budget" "budget" { … }

# Stubs are intentional: wiring needs project/notification-channel ids that
# are per-consumer one-time setup. terraform validate passes on the module
# shape; fill the resources when the repo first deploys.
