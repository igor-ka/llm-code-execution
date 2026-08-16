# Two budgets, because one cannot express both questions (P1-D6).
#
# By default a budget measures spend NET of credits — which, on a $300 trial, reads ≈ $0 until the
# credits are exhausted. A single default budget therefore stays silent through the entire period
# it is supposed to be watching, then fires once the money is real. That is the wrong alarm.
#
# The OTHER default is just as load-bearing and less obvious: with neither calendar_period nor
# custom_period set, the API applies calendar_period = MONTH. A gross budget of $300 per calendar
# MONTH would never fire at this project's burn rate (~$8-10/mo), silently reproducing the exact
# failure this pair exists to prevent. custom_period pins the first budget to the trial itself.
#
# Both notify the billing account's admins and users by email, which requires no Pub/Sub topic and
# no monitoring notification channel. For a single-owner project that is the whole audience.
locals {
  # tonumber because the API wants integers, not the zero-padded strings the date splits into.
  trial_start = split("-", var.trial_start_date)
}

# 1. Credit burn. EXCLUDE_ALL_CREDITS makes this measure GROSS spend against the $300 grant, and
#    custom_period makes it accumulate across the whole trial — together, the number that answers
#    "how much of the trial is left".
resource "google_billing_budget" "credit_burn" {
  billing_account = var.billing_account
  display_name    = "llm-code-execution trial credit burn"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"

    # No end_date: an open-ended custom period accumulates from activation onward, so the budget
    # keeps answering the question until the project is deleted. Mutually exclusive with
    # calendar_period, which is the point.
    custom_period {
      start_date {
        year  = tonumber(local.trial_start[0])
        month = tonumber(local.trial_start[1])
        day   = tonumber(local.trial_start[2])
      }
    }
  }

  amount {
    specified_amount {
      # The billing account's own currency, not USD. A budget denominated in anything else is
      # rejected with a bare "Request contains an invalid argument" that names no field — this
      # account bills in CAD, and a USD budget failed identically whether minimal or complete.
      currency_code = var.billing_currency
      units         = var.trial_credit_amount
    }
  }

  # ACTUAL spend only. The plan wanted a FORECASTED_SPEND rule here — at a steady burn it warns
  # weeks earlier — but the API refuses it outright:
  #
  #   Error 400: Threshold percent based on forecast spend cannot be set with Custom Period.
  #
  # Forecasting and custom_period are mutually exclusive, and custom_period is the half that
  # cannot be given up: without it the API defaults to calendar_period = MONTH, and a $300 MONTHLY
  # gross budget never fires at ~$8-10/mo — the budget would be silent for the entire trial, which
  # is the exact failure P1-D6 exists to prevent. So the early warning is bought back with denser
  # actual thresholds rather than a forecast.
  threshold_rules { threshold_percent = 0.25 }
  threshold_rules { threshold_percent = 0.50 }
  threshold_rules { threshold_percent = 0.75 }
  threshold_rules { threshold_percent = 0.90 }
  threshold_rules { threshold_percent = 1.0 }

  depends_on = [google_project_service.phase1]
}

# 2. Real money. Credits INCLUDED, so this stays at zero for as long as the credits cover
#    everything and fires the moment they do not — the day-91 tripwire, and the alarm that fires
#    if a resource outlives a teardown that was believed complete.
#
#    This one KEEPS the default monthly period deliberately: "did I pay anything this month" is a
#    monthly question, and a monthly reset means it can fire again next month rather than staying
#    latched after the first dollar.
resource "google_billing_budget" "real_spend" {
  billing_account = var.billing_account
  display_name    = "llm-code-execution actual charges"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.billing_currency
      units         = "1"
    }
  }

  threshold_rules { threshold_percent = 1.0 }

  depends_on = [google_project_service.phase1]
}
