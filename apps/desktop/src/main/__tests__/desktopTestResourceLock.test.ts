import { describe, expect, it } from 'vitest';

import {
  decideDesktopTestLock,
  type DesktopTestLockProbeResult,
} from '../../test/vitest/desktopTestResourceLock';

function probes(...results: DesktopTestLockProbeResult[]) {
  return results.map((result, index) => ({ port: 50_000 + index, result }));
}

describe('decideDesktopTestLock', () => {
  it('waits for an existing owner on a fallback port before taking an earlier free port', () => {
    expect(decideDesktopTestLock(probes('retry', 'owner', 'collision'))).toEqual({
      type: 'wait',
    });
  });

  it('takes the first available candidate only when no existing owner was found', () => {
    expect(decideDesktopTestLock(probes('collision', 'retry', 'retry'))).toEqual({
      type: 'acquire',
      port: 50_001,
    });
  });

  it('fails closed when every deterministic candidate belongs to an unrelated service', () => {
    expect(decideDesktopTestLock(probes('collision', 'collision'))).toEqual({
      type: 'unavailable',
    });
  });
});
