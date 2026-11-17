import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { measureDownload, parseUrl } from '../src/index.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/file`);
  } finally {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }
}

test('downloads ten complete responses sequentially and calculates metrics', async () => {
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  await withServer((req, res) => {
    requests += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    assert.equal(req.headers['accept-encoding'], 'identity');
    res.write(Buffer.alloc(128));
    setTimeout(() => {
      active -= 1;
      res.end(Buffer.alloc(384));
    }, 10);
  }, async (url) => {
    const result = await measureDownload(url);
    assert.equal(requests, 10);
    assert.equal(maxActive, 1);
    assert.equal(result.requestCount, 10);
    assert.equal(result.totalBytes, 5120);
    assert.ok(result.totalTimeMs >= 100);
    assert.equal(result.averageTimeMs, result.totalTimeMs / 10);
    assert.equal(result.speedMbps, 5120 * 8 / (result.totalTimeMs / 1000) / 1_000_000);
  });
});

test('stops on an unsuccessful HTTP response', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests += 1;
    res.writeHead(404).end('Not found');
  }, async (url) => {
    await assert.rejects(measureDownload(url), /Request 1\/10 failed: HTTP 404/);
    assert.equal(requests, 1);
  });
});

test('times out while waiting for the complete response body', async () => {
  await withServer((req, res) => {
    res.write('incomplete body');
  }, async (url) => {
    await assert.rejects(measureDownload(url, { timeoutMs: 100 }), /Request 1\/10 failed/);
  });
});

test('validates URLs', () => {
  assert.equal(parseUrl('https://example.com/image').protocol, 'https:');
  assert.throws(() => parseUrl('not a url'));
  assert.throws(() => parseUrl('file:///tmp/image'), /http/);
  assert.throws(() => parseUrl('https://user:password@example.com'), /credentials/);
});

test('CLI prints the results', async () => {
  await withServer((req, res) => res.end('hello'), async (url) => {
    const { stdout, stderr } = await exec(process.execPath, [cli, url]);
    assert.equal(stderr, '');
    assert.match(stdout, /Completed requests: 10/);
    assert.match(stdout, /Average request time: [\d.]+ ms/);
    assert.match(stdout, /Total downloaded: 50 bytes/);
    assert.match(stdout, /Download speed: [\d.]+ Mbps/);
  });
});

test('CLI supports help and exits unsuccessfully for invalid arguments', async () => {
  const { stdout } = await exec(process.execPath, [cli, '--help']);
  assert.match(stdout, /Usage:/);
  for (const args of [[], ['invalid'], ['ftp://example.com'], ['a', 'b']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args]), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Error:/);
      return true;
    });
  }
});
