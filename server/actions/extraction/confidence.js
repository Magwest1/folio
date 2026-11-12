// Confidence and routing thresholds. Kept separate so the formula is documented and unit-testable.
//
//   confidence = clamp01(0.40 * detector + 0.50 * model + 0.10 * explicit - 0.05 * groundingIssues)
//
// - detector: the rule-based candidate score (0..1).
// - model: the mean over samples of the per-sample agreement. A sample that says "not an action" scores 0;
//   an action sample scores ACTOR_AGREEMENT[actor] (me 1, we 0.8, other 0.7, unknown 0.6), multiplied by
//   `tokenProbability` (0.5 + 0.5 * p) when the generator reports one (#23).
// - explicit: 1 when the detector flagged the candidate as an explicit commitment or checkbox.
// - groundingIssues: person/time fields the model supplied that the span did not support.
export const AUTO_THRESHOLD = 0.85
export const SUGGEST_THRESHOLD = 0.5
export const BORDERLINE_LOW = 0.4
export const BORDERLINE_HIGH = 0.6

export const WEIGHTS = { detector: 0.4, model: 0.5, explicit: 0.1, issuePenalty: 0.05 }
export const ACTOR_AGREEMENT = { me: 1, we: 0.8, other: 0.7, unknown: 0.6 }

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/** Agreement of one model sample, 0..1. `tokenProbability` is optional (0..1). */
export function sampleAgreement(output, tokenProbability = null) {
  if (!output?.isAction) return 0
  const base = ACTOR_AGREEMENT[output.actor] ?? ACTOR_AGREEMENT.unknown
  return typeof tokenProbability === 'number' ? base * (0.5 + 0.5 * clamp01(tokenProbability)) : base
}

export function computeConfidence({ detector, model, explicit, issues = 0 }) {
  const value = WEIGHTS.detector * detector + WEIGHTS.model * model + WEIGHTS.explicit * (explicit ? 1 : 0) - WEIGHTS.issuePenalty * issues
  return Math.round(clamp01(value) * 1000) / 1000
}
