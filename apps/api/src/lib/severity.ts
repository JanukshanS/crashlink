/**
 * §5.6.5 severity index - a heuristic, always displayed with its disclaimer
 * ("not a medical assessment"). MANUAL_SOS has no score: a rider who pressed
 * the button does not need a sensor to rank their emergency.
 */
import type { IncidentType, SeverityLabel } from '@crashlink/contracts';

export interface SeverityInputs {
  peakAccelerationG?: number | null;
  peakRotationDps?: number | null;
  preEventSpeedKph?: number | null;
  fallenDurationMs?: number | null;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * score = 35*min(peakG/4, 1) + 25*min(peakDps/300, 1)
 *       + 25*min(preEventSpeedKph/40, 1)   (0 if unknown)
 *       + 15*(fallenDurationMs >= 10000)
 */
export const severityScore = (inputs: SeverityInputs): number => {
  const peakG = inputs.peakAccelerationG ?? 0;
  const peakDps = inputs.peakRotationDps ?? 0;
  const speed = inputs.preEventSpeedKph ?? 0;
  const fallen = inputs.fallenDurationMs ?? 0;

  return Math.round(
    35 * clamp01(peakG / 4.0) +
      25 * clamp01(peakDps / 300) +
      25 * clamp01(speed / 40) +
      15 * (fallen >= 10000 ? 1 : 0),
  );
};

/**
 * The score for a newly created incident, or null when the index does not
 * apply.
 *
 * §5.6.5 is a *crash* heuristic: peak g, rotation, speed and time fallen. It
 * only means something for an EMERGENCY fall. Scoring a towing alert or a
 * pothole with it would print a confident-looking number that measures
 * nothing, so those get no score at all. MANUAL_SOS is EMERGENCY but has a
 * null score by definition (§5.6.5).
 *
 * TODO(spec): §5.6.5 does not say which categories carry a severity index;
 * restricting it to EMERGENCY is the reading that never overstates.
 */
export const scoreForIncident = (
  type: IncidentType,
  category: 'EMERGENCY' | 'SECURITY' | 'INFO',
  inputs: SeverityInputs,
): number | null => {
  if (category !== 'EMERGENCY' || type === 'MANUAL_SOS') return null;
  return severityScore(inputs);
};

export const severityLabel = (score: number | null, type: IncidentType): SeverityLabel => {
  if (type === 'MANUAL_SOS') return 'SOS';
  if (score === null) return 'LOW';
  if (score < 35) return 'LOW';
  if (score <= 65) return 'MODERATE';
  return 'HIGH';
};

export const severityOf = (
  score: number | null,
  type: IncidentType,
): { score: number | null; label: SeverityLabel } => ({
  // §5.6.5: MANUAL_SOS carries a null score, whatever the sensors said.
  score: type === 'MANUAL_SOS' ? null : score,
  label: severityLabel(score, type),
});
