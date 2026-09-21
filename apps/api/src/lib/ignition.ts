/**
 * §5.6.5 riding / parked time (FR-RENT-06).
 *
 * "Walk ignition_events in order; ON→OFF spans are riding, OFF→ON spans are
 * parked; the open span runs to now."
 *
 * Time whose state we do not know - before the first event we have ever seen -
 * is reported separately as `unknownSec` and never folded into either total.
 * Guessing "parked" for a bike that was simply not reporting yet would be
 * inventing data.
 */
export type IgnitionState = 'ON' | 'OFF' | 'UNKNOWN';

export interface IgnitionSample {
  state: IgnitionState;
  at: Date;
}

export interface IgnitionSpans {
  ridingSec: number;
  parkedSec: number;
  unknownSec: number;
}

/**
 * Splits `[from, to]` into riding, parked and unknown seconds.
 *
 * @param stateAtStart the state in force at `from` - the last event before the
 *   window, or UNKNOWN if there was none.
 * @param events events inside the window, in any order; ones outside
 *   `(from, to]` are ignored, so a device clock running ahead cannot add time
 *   that has not happened yet.
 */
export const ignitionSpans = (
  stateAtStart: IgnitionState,
  events: IgnitionSample[],
  from: Date,
  to: Date,
): IgnitionSpans => {
  const totals: IgnitionSpans = { ridingSec: 0, parkedSec: 0, unknownSec: 0 };
  if (to.getTime() <= from.getTime()) return totals;

  const add = (state: IgnitionState, ms: number): void => {
    if (ms <= 0) return;
    const sec = ms / 1000;
    if (state === 'ON') totals.ridingSec += sec;
    else if (state === 'OFF') totals.parkedSec += sec;
    else totals.unknownSec += sec;
  };

  const inWindow = events
    .filter((event) => event.at.getTime() > from.getTime() && event.at.getTime() <= to.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  let cursor = from.getTime();
  let state = stateAtStart;

  for (const event of inWindow) {
    add(state, event.at.getTime() - cursor);
    state = event.state;
    cursor = event.at.getTime();
  }
  add(state, to.getTime() - cursor);

  return {
    ridingSec: Math.round(totals.ridingSec),
    parkedSec: Math.round(totals.parkedSec),
    unknownSec: Math.round(totals.unknownSec),
  };
};
