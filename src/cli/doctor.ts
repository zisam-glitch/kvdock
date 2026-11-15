import { performance } from "node:perf_hooks";
import type { KVDock } from "../core/store.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly ms?: number;
  readonly detail?: string;
}

export interface DoctorOutcome {
  readonly ok: boolean;
  readonly checks: DoctorCheck[];
}

const PROBE_PREFIX = "kvdock-doctor";
const DEFAULT_PROBES = 100;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

/**
 * Runs roundtrip health checks against the store: connectivity (ping), write,
 * read, and delete, each measured in milliseconds. All checks are recorded
 * even when earlier ones fail, so the report stays complete.
 */
export async function runDoctor(
  dock: KVDock,
  options: { probes?: number } = {},
): Promise<DoctorOutcome> {
  const probes = options.probes ?? DEFAULT_PROBES;
  const checks: DoctorCheck[] = [];

  try {
    const { ms } = await measure(() => dock.has(`${PROBE_PREFIX}:probe`));
    checks.push({ name: "Ping latency", ok: true, ms });
  } catch (err) {
    checks.push({ name: "Ping latency", ok: false, detail: errorMessage(err) });
  }

  try {
    const { ms } = await measure(async () => {
      for (let i = 0; i < probes; i++) {
        await dock.set(`${PROBE_PREFIX}:w:${i}`, { idx: i });
      }
    });
    checks.push({ name: `Write test (${probes} keys)`, ok: true, ms });
  } catch (err) {
    checks.push({ name: `Write test (${probes} keys)`, ok: false, detail: errorMessage(err) });
  }

  try {
    const { value: allRead, ms } = await measure(async () => {
      for (let i = 0; i < probes; i++) {
        const val = await dock.get<{ idx: number }>(`${PROBE_PREFIX}:w:${i}`);
        if (val === null || val.idx !== i) return false;
      }
      return true;
    });
    checks.push({ name: `Read test (${probes} keys)`, ok: allRead, ms });
  } catch (err) {
    checks.push({ name: `Read test (${probes} keys)`, ok: false, detail: errorMessage(err) });
  }

  try {
    const { value: allDeleted, ms } = await measure(async () => {
      for (let i = 0; i < probes; i++) {
        if (!(await dock.delete(`${PROBE_PREFIX}:w:${i}`))) return false;
      }
      return true;
    });
    checks.push({ name: `Delete test (${probes} keys)`, ok: allDeleted, ms });
  } catch (err) {
    checks.push({ name: `Delete test (${probes} keys)`, ok: false, detail: errorMessage(err) });
  }

  // Best-effort sweep so partial failures do not leak probe keys.
  try {
    for (const key of await dock.keys(`${PROBE_PREFIX}:*`)) {
      await dock.delete(key);
    }
  } catch {
    // Cleanup is best-effort.
  }

  return { ok: checks.every((check) => check.ok), checks };
}
