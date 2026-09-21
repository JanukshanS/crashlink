/**
 * Stand-in for the ESP32's NVS (Preferences) partition.
 *
 * §5.3.4 requires the device to persist the assignment snapshot *before* it
 * acks SET_ASSIGNMENT, and to still hold it after a reboot. The simulator is a
 * fresh process on every run, so without this it would "forget" the rider
 * between scenarios and stop matching the rental - which is exactly the bug
 * this file exists to avoid reproducing.
 *
 * State lives next to the simulator, one file per device code, and is
 * gitignored along with everything else that holds device data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Assignment } from './machine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, '../.state');

export interface DeviceState {
  assignment: Assignment | null;
  configVersion: number;
}

const EMPTY: DeviceState = { assignment: null, configVersion: 1 };

const statePath = (deviceCode: string): string => resolve(STATE_DIR, `${deviceCode}.json`);

export const loadState = (deviceCode: string): DeviceState => {
  const path = statePath(deviceCode);
  if (!existsSync(path)) return { ...EMPTY };

  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<DeviceState>) };
  } catch {
    // A corrupt partition behaves like a blank one, as the firmware should.
    return { ...EMPTY };
  }
};

export const saveState = (deviceCode: string, state: DeviceState): void => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(deviceCode), JSON.stringify(state, null, 2), 'utf8');
};

export const clearState = (deviceCode: string): void => {
  saveState(deviceCode, { ...EMPTY });
};
