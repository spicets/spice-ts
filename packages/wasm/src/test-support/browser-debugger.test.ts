import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageDebuggerUrl } from './browser-debugger.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('Chrome page debugger discovery', () => {
  it('waits between successful endpoint responses while the page is not ready', async () => {
    vi.useFakeTimers();
    vi.mocked(readFile).mockResolvedValue('9222\n/devtools/browser/test');
    const fetchTargets = vi.fn().mockImplementation(async () => ({
      json: async () => Date.now() < 500
        ? []
        : [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/page' }],
    }));
    vi.stubGlobal('fetch', fetchTargets);
    vi.setSystemTime(0);
    const result = pageDebuggerUrl('/profile').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe('ws://127.0.0.1:9222/page');
    expect(fetchTargets).toHaveBeenCalledTimes(11);
    expect(fetchTargets).toHaveBeenCalledWith('http://127.0.0.1:9222/json/list');
  });

  it('keeps the existing bounded failure when Chrome never exposes a page', async () => {
    vi.useFakeTimers();
    vi.mocked(readFile).mockRejectedValue(new Error('port file not ready'));
    const fetchTargets = vi.fn();
    vi.stubGlobal('fetch', fetchTargets);
    const assertion = expect(pageDebuggerUrl('/profile')).rejects.toThrow(
      'Chrome DevTools endpoint did not become ready',
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(readFile).toHaveBeenCalledTimes(400);
    expect(fetchTargets).not.toHaveBeenCalled();
  });
});
