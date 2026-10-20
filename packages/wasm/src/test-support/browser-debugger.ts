import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function pageDebuggerUrl(profileDirectory: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const [port] = (await readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8')).split('\n');
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = targets.find(target => target.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Chrome may not have written its port file or started HTTP yet. */ }
    // A live endpoint can return no page during startup. Pace that case too,
    // otherwise all attempts can expire before Chrome creates about:blank.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error('Chrome DevTools endpoint did not become ready');
}
