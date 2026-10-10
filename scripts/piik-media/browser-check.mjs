import { build } from "esbuild";
import { createServer } from "node:http";
const result = await build({ entryPoints: ['scripts/piik-media/browser-check.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(result.outputFiles[0].text); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><meta charset="utf-8"><title>WebSpeak Piik media verification</title><h1>WebSpeak Piik media verification</h1><p>Synthetic local P2P test; no microphone or desktop capture.</p><button>Run synthetic test</button><canvas style="width:300px"></canvas><video muted autoplay style="width:300px"></video><video muted autoplay style="width:300px"></video><pre>Ready</pre><script type="module" src="/fixture.js"></script>');
});
server.listen(5592, '127.0.0.1', () => console.log('Synthetic media check at http://127.0.0.1:5592'));
