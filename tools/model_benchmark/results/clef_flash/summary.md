# Clef-flash evaluation

## Status

**BLOCKED — numeric evaluation and adoption decision are not possible from this checkout.** No model quality score is claimed.

## Evaluation scope

- Dataset: `tools/model_benchmark/dataset/articles/*.json`
- Files found: 53
- Planned: all 53 articles × 2 repeats (106 requests)
- Ground truth: 0/53 independently labeled
- Live API requests: 0
- Dry-run: completed for all 53 articles
- Model: `@cf/cloudflare/clef-flash`

## Labeling

Ground truth must be an independent review using the six-category rubric in `ground_truth.json`, with a short rationale and input SHA-256 for every article. `legacy.app_categories` was not used. The checked-in title and description fields are mojibake, preventing reliable interpretation and audit; writing labels would fabricate evidence. The blank template is preserved in `ground_truth.json`.

## API method

The harness uses the official Workers AI REST endpoint `/ai/run/@cf/cloudflare/clef-flash` and the Decision Model body `{model, state, questions}`. It sends title and description in `state`, asks a `choice` question with the six categories, and parses `answers.news_category.choice`. The official model page describes per-option probabilities and a confidence value for choice answers. No chat `messages` or prompt-based generation is used.

## Metrics

| Measure | Result |
|---|---:|
| Accuracy | N/A — no labels or live predictions |
| Macro-F1 | N/A — no labels or live predictions |
| Exclusion precision / recall / F1 | N/A — no labels or live predictions |
| Confusion matrix | N/A |
| Repeat agreement | N/A — 0 repeats completed |
| Latency p50 / p95 | N/A — no API requests |
| Failure rate | N/A — no API requests attempted |
| Input / output tokens | N/A |
| Cost | Not estimated |

## Existing model comparison

Not comparable. No prior result files were present in `tools/model_benchmark/results` before this task, and the Clef evaluation was blocked. Therefore no cross-model figures are presented.

## Blockers and conclusion

1. Neither `CLOUDFLARE_ACCOUNT_ID` nor `CLOUDFLARE_API_TOKEN` was present in the process environment (presence-only check; values were not read or printed). Live evaluation could not run.
2. Article text in this checkout is mojibake, so independent auditable labels for 53 articles could not be assigned.

**Final decision: BLOCKED.** This is not an adoption approval or rejection based on model performance. To complete the requested empirical adoption decision, restore readable source text, have a reviewer independently label all 53 records against the rubric, then run the live harness with available Cloudflare credentials.

## Harness capabilities

The evaluator computes accuracy, macro precision/recall/F1, weighted F1, per-category precision/recall/F1/support, exclusion binary confusion counts, repeat agreement and article-level variation, category stability, latency percentiles/average/min/max, and token totals when returned by the API. It records request/API/response errors without logging credentials or article text.
