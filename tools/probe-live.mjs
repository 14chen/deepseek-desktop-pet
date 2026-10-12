/** Check the live pet endpoints without blocking on the SSE stream. */
import http from 'node:http';

const PORT = 19387;
const BASE = '/pet';

function probe(path, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port: PORT, path, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        // The event stream never ends; a first frame is all we need.
        chunks.push(chunk);
        if (response.headers['content-type']?.includes('event-stream')) response.destroy();
      });
      response.on('end', () => resolve({
        path, method, status: response.statusCode, type: response.headers['content-type'],
      }));
      response.on('close', () => resolve({
        path, method, status: response.statusCode, type: response.headers['content-type'],
      }));
    });
    request.on('error', (error) => resolve({ path, method, status: 'ERR', type: error.message }));
    setTimeout(() => request.destroy(), 4000);
    if (body) {
      request.setHeader('content-type', 'application/json');
      request.end(JSON.stringify(body));
    } else {
      request.end();
    }
  });
}

const checks = [
  [`${BASE}/api/state`, 'GET'],
  [`${BASE}/api/events`, 'GET'],
  [`${BASE}/api/action`, 'POST'],
  [`${BASE}/api/health`, 'GET'],
  [`${BASE}/health`, 'GET'],
  [`${BASE}/`, 'GET'],
  [`${BASE}/pet.js`, 'GET'],
];

for (const [path, method] of checks) {
  const result = await probe(path, method, method === 'POST' ? { type: 'pet' } : null);
  const note = result.status === 404 ? '   <-- the running plugin predates this route' : '';
  console.log(`  ${path.padEnd(20)} ${method.padEnd(5)} -> ${String(result.status).padEnd(4)} ${result.type ?? ''}${note}`);
}
