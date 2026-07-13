import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import type { DebugPlugin } from '../../interfaces/plugin.interface';
import type { MemorySnapshot, RequestProfile } from '../../interfaces/profile.interface';
import { round2 } from '../../utils/common';

function snapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

/**
 * Built-in plugin (auto-registered when `captureMemory` is on): snapshots
 * heap/RSS at request start/end and samples event-loop delay.
 *
 * Note: the event-loop histogram is process-wide, so under concurrent load
 * the delay reflects the whole process, not a single request.
 */
export class MemoryPlugin implements DebugPlugin {
  readonly name = 'memory';
  private histogram?: IntervalHistogram;

  register(): void {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
  }

  onRequestStart(profile: RequestProfile): void {
    profile.memory = { before: snapshot() };
  }

  onRequestEnd(profile: RequestProfile): void {
    const before = profile.memory?.before;
    const after = snapshot();
    const meanNs = this.histogram?.mean;
    profile.memory = {
      before,
      after,
      heapUsedDelta: before ? after.heapUsed - before.heapUsed : undefined,
      eventLoopDelayMs:
        meanNs !== undefined && Number.isFinite(meanNs) ? round2(meanNs / 1e6) : undefined,
    };
    this.histogram?.reset();
  }

  onShutdown(): void {
    this.histogram?.disable();
  }
}
