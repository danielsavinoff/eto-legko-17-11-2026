import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const REQUEST_COUNT = 10;
const TIMEOUT_MS = 30_000;

export function parseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('URL must use http:// or https://.');
  }
  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not supported.');
  }
  return url;
}

export async function measureDownload(address, { timeoutMs = TIMEOUT_MS } = {}) {
  const url = parseUrl(address);
  let totalBytes = 0;
  let totalTimeMs = 0;

  for (let index = 0; index < REQUEST_COUNT; index += 1) {
    const startedAt = performance.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Cache-Control': 'no-cache',
          'Accept-Encoding': 'identity',
        },
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // Consume the entire response without keeping the whole file in memory.
      if (response.body) {
        for await (const chunk of response.body) {
          totalBytes += chunk.byteLength;
        }
      }
      totalTimeMs += performance.now() - startedAt;
    } catch (error) {
      const reason = error.name === 'TimeoutError'
        ? `timed out after ${timeoutMs} ms`
        : error.message;
      throw new Error(`Request ${index + 1}/${REQUEST_COUNT} failed: ${reason}`, {
        cause: error,
      });
    }
  }

  return {
    requestCount: REQUEST_COUNT,
    totalBytes,
    totalTimeMs,
    averageTimeMs: totalTimeMs / REQUEST_COUNT,
    speedMbps: (totalBytes * 8) / (totalTimeMs / 1000) / 1_000_000,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: npm start -- <http(s)://url>');
    return;
  }
  if (args.length !== 1) {
    throw new Error('Provide exactly one URL. Usage: npm start -- <http(s)://url>');
  }

  const result = await measureDownload(args[0]);
  console.log(`Completed requests: ${result.requestCount}`);
  console.log(`Average request time: ${result.averageTimeMs.toFixed(2)} ms`);
  console.log(`Total downloaded: ${result.totalBytes} bytes`);
  console.log(`Total request time: ${(result.totalTimeMs / 1000).toFixed(3)} s`);
  console.log(`Download speed: ${result.speedMbps.toFixed(3)} Mbps`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
