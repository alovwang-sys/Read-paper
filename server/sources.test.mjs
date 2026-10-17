import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { createRemoteReader, createSourceService, isPublicAddress, normalizeSource, parseHTMLMetadata, remoteURL } from './sources.mjs';
import { createAIHandler } from './ai.mjs';

function network(routes, { lookup, timeoutMs } = {}) {
  const calls = [];
  const dns = [];
  return {
    calls, dns,
    options: {
      timeoutMs,
      lookup: async (host, options) => {
        dns.push(host);
        return lookup ? lookup(host, options) : [{ address: '93.184.216.34', family: 4 }];
      },
      requestImpl: (url, options, callback) => {
        calls.push({ url: url.href, options });
        const req = new EventEmitter();
        req.end = () => queueMicrotask(() => {
          const abort = () => req.emit('error', options.signal.reason || new Error('aborted'));
          if (options.signal.aborted) { abort(); return; }
          options.signal.addEventListener('abort', abort, { once: true });
          const route = typeof routes === 'function' ? routes(url.href) : routes[url.href];
          if (route instanceof Error) { options.signal.removeEventListener('abort', abort); req.emit('error', route); return; }
          if (route?.hang) return;
          const res = new PassThrough();
          res.statusCode = route?.status || 200;
          res.headers = route?.headers || {};
          res.on('close', () => options.signal.removeEventListener('abort', abort));
          callback(res);
          if (!res.destroyed) for (const bytes of route?.chunks || [route?.body || '']) { if (!res.destroyed) res.write(bytes); }
          if (!res.destroyed) res.end();
        });
        return req;
      },
    },
  };
}

const atom = `<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><title> Attention Is All You Need </title><summary> An original &amp; official abstract. </summary><published>2017-06-12T00:00:00Z</published><author><name>Ashish Vaswani</name></author><link title="pdf" href="https://arxiv.org/pdf/1706.03762v7" type="application/pdf"/></entry></feed>`;

test('来源输入识别 DOI、arXiv 及旧编号，拒绝凭据、内网和非 HTTP(S)', () => {
  assert.equal(normalizeSource('doi:10.1000/ABC').url, 'https://doi.org/10.1000/ABC');
  assert.equal(normalizeSource('https://dx.doi.org/10.1000%2FABC').identifiers.doi, '10.1000/abc');
  for (const value of ['arxiv:1706.03762v7', 'https://arxiv.org/pdf/1706.03762v7.pdf']) assert.equal(normalizeSource(value).identifiers.arxiv, '1706.03762v7');
  assert.equal(normalizeSource('hep-th/9901001').identifiers.arxiv, 'hep-th/9901001');
  for (const value of ['', null, 'not a link', 'file:///etc/passwd', 'https://user:password@example.com', 'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254/latest', 'https://localhost', 'http://host.internal', 'http://example.com:1234']) assert.throws(() => normalizeSource(value), value);
});

test('地址过滤覆盖私有、保留、IPv6 映射和过渡网段', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.2', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1', 'not-ip']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('HTML 元数据提取可追踪原摘要，普通 description 和脚本不冒充作者摘要', () => {
  const url = 'https://publisher.example/paper';
  const metadata = parseHTMLMetadata(`<title>Fallback</title><meta property="og:title" content="OG title"><meta name="citation_title" content="A &amp; B"><meta name='citation_author' content='First Author'><meta content='Second Author' name='citation_author'><meta name="citation_publication_date" content="2024/01/02"><meta name="citation_doi" content="10.1000/ABC"><meta name="citation_pdf_url" content="/pdf/a.pdf"><meta name="citation_abstract" content="The author&apos;s original abstract.">`, url, 'fixed-time');
  assert.equal(metadata.title, 'A & B');
  assert.equal(metadata.authors, 'First Author, Second Author');
  assert.equal(metadata.year, '2024');
  assert.equal(metadata.identifiers.doi, '10.1000/abc');
  assert.deepEqual(metadata.abstract, { text: "The author's original abstract.", url, retrievedAt: 'fixed-time' });
  assert.equal(metadata.pdfUrl, 'https://publisher.example/pdf/a.pdf');
  const page = parseHTMLMetadata(`<title>Website</title><meta name="description" content="Promotional summary"><meta property="og:description" content="Another summary"><script><meta name="citation_abstract" content="not real"></script>`, url);
  assert.equal(page.title, 'Website');
  assert.equal(page.abstract, undefined);
  assert.equal(parseHTMLMetadata('<meta name="citation_pdf_url" content="http://127.0.0.1/a.pdf">', url).pdfUrl, undefined);
});

test('arXiv Atom 保留摘要来源、作者、年份和带版本 PDF', async () => {
  const net = network(() => ({ body: atom }));
  const result = await createSourceService(net.options).resolve('https://arxiv.org/abs/1706.03762v7');
  assert.equal(net.calls.length, 1);
  assert.equal(result.title, 'Attention Is All You Need');
  assert.equal(result.authors, 'Ashish Vaswani');
  assert.equal(result.year, '2017');
  assert.equal(result.abstract.text, 'An original & official abstract.');
  assert.match(result.abstract.url, /^https:\/\/export.arxiv.org\/api\/query\?id_list=/);
  assert.equal(result.abstract.retrievedAt, result.resolvedAt);
  assert.equal(result.pdfUrl, 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(result.kind, 'paper');
});

test('arXiv API 失败回退官方摘要页；均失败时仍返回可收录的线索', async () => {
  const net = network(url => url.includes('export.') ? new Error('offline') : { body: '<meta name="citation_title" content="Title"><blockquote class="abstract mathjax"><span>Abstract:</span> Original abstract. </blockquote>' });
  const result = await createSourceService(net.options).resolve('1706.03762');
  assert.equal(result.title, 'Title');
  assert.equal(result.abstract.text, 'Original abstract.');
  assert.equal(result.abstract.url, 'https://arxiv.org/abs/1706.03762');
  const offline = await createSourceService(network(() => new Error('secret network error')).options).resolve('1706.03762');
  assert.equal(offline.identifiers.arxiv, '1706.03762');
  assert.match(offline.warning, /无法连接/);
  assert.equal(offline.warning.includes('secret'), false);
  const versioned = await createSourceService(network(url => url.includes('export.') ? new Error('offline') : { body: '<meta name="citation_title" content="Title"><meta name="citation_pdf_url" content="https://arxiv.org/pdf/1706.03762">' }).options).resolve('1706.03762v7');
  assert.equal(versioned.pdfUrl, 'https://arxiv.org/pdf/1706.03762v7');
});

test('Crossref 来源补全与出版社 PDF 线索合并，不把站点介绍写成摘要', async () => {
  const net = network(url => url.includes('crossref.org') ? { body: JSON.stringify({ message: { title: ['Official title'], author: [{ given: 'First', family: 'Author' }], published: { 'date-parts': [[2023, 1, 1]] }, abstract: '<jats:p>Original author abstract.</jats:p>' } }) }
    : { body: '<title>Publisher generic page</title><meta name="citation_pdf_url" content="https://publisher.example/paper.pdf"><meta name="description" content="Publisher promotion">' });
  const result = await createSourceService(net.options).resolve('10.1000/test');
  assert.equal(result.title, 'Official title');
  assert.equal(result.authors, 'First Author');
  assert.equal(result.year, '2023');
  assert.equal(result.pdfUrl, 'https://publisher.example/paper.pdf');
  assert.equal(result.abstract.text, 'Original author abstract.');
  assert.match(result.abstract.url, /api.crossref.org/);
  assert.equal(net.calls.length, 2);
});

test('Crossref 明确 PDF 直接返回；普通网页仅读取明确元数据，失败保留链接', async () => {
  const net = network(() => ({ body: JSON.stringify({ message: { title: ['Title'], link: [{ 'content-type': 'application/pdf', URL: 'https://publisher.example/full.pdf' }] } }) }));
  assert.equal((await createSourceService(net.options).resolve('10.1000/test')).pdfUrl, 'https://publisher.example/full.pdf');
  assert.equal(net.calls.length, 1);
  const web = await createSourceService(network(() => ({ body: '<meta property="og:title" content="A useful article"><meta name="description" content="An intro">' })).options).resolve('https://article.example/post#part');
  assert.equal(web.title, 'A useful article');
  assert.equal(web.url, 'https://article.example/post');
  assert.equal(web.kind, 'web');
  assert.equal(web.abstract, undefined);
  const fallback = await createSourceService(network(() => ({ status: 403 })).options).resolve('https://article.example/post');
  assert.equal(fallback.title, 'article.example/post');
  assert.match(fallback.warning, /限制访问/);
  const empty = await createSourceService(network(() => ({ body: '<html><body>Login</body></html>' })).options).resolve('https://article.example/post');
  assert.match(empty.warning, /暂未取得文献信息/);
});

test('每跳先检查 DNS，拒绝混合地址与私网重定向，并将已验证地址绑定到连接', async () => {
  const blocked = network(() => ({ body: 'never' }), { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(createRemoteReader(blocked.options)('https://public.example'), /非公开网络/);
  assert.equal(blocked.calls.length, 0);
  const redirect = network(url => url.includes('public.example') ? { status: 302, headers: { location: 'https://private.example/secret' } } : { body: 'never' }, {
    lookup: async host => [{ address: host === 'private.example' ? '10.0.0.2' : '93.184.216.34', family: 4 }],
  });
  await assert.rejects(createRemoteReader(redirect.options)('https://public.example'), /非公开网络/);
  assert.equal(redirect.calls.length, 1);
  const pinned = network(() => ({ body: 'ok' }));
  await createRemoteReader(pinned.options)('https://public.example');
  assert.deepEqual(pinned.dns, ['public.example']);
  const pinnedLookup = pinned.calls[0].options.lookup;
  pinnedLookup('public.example', { family: 4 }, (error, address, family) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
  pinnedLookup('public.example', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
  const numeric = network(() => ({ body: 'ok' }));
  await createRemoteReader(numeric.options)('https://[2606:4700:4700::1111]');
  assert.equal(numeric.dns.length, 0);
});

test('获取限制覆盖重定向次数、DNS/连接超时、响应状态及声明/流式大小', async () => {
  const loop = network(() => ({ status: 302, headers: { location: '/loop' } }));
  await assert.rejects(createRemoteReader(loop.options)('https://public.example'), /重定向过多/);
  assert.equal(loop.calls.length, 6);
  const timeout = network(() => ({ hang: true }), { timeoutMs: 10 });
  await assert.rejects(createRemoteReader(timeout.options)('https://public.example'), /超时/);
  const dnsTimeout = network(() => ({ body: '' }), { timeoutMs: 10, lookup: () => new Promise(() => {}) });
  await assert.rejects(createRemoteReader(dnsTimeout.options)('https://public.example'), /超时/);
  const largeHeaders = network(() => ({ headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }));
  await assert.rejects(createRemoteReader(largeHeaders.options)('https://public.example'), /2 MB/);
  const largeChunks = network(() => ({ chunks: [Buffer.alloc(10), Buffer.alloc(10)] }));
  await assert.rejects(createRemoteReader(largeChunks.options)('https://public.example', { maxBytes: 15 }), /大小限制/);
  await assert.rejects(createRemoteReader(network(() => ({ status: 403 })).options)('https://public.example'), /限制访问/);
});

test('PDF 下载检查 magic，拒绝 HTML 冒充、过大文件和内网跳转', async () => {
  const pdf = Buffer.from('%PDF-1.7\nvalid content');
  assert.deepEqual(await createSourceService(network(() => ({ body: pdf, headers: { 'content-type': 'application/octet-stream' } })).options).pdf('https://public.example/paper'), pdf);
  await assert.rejects(createSourceService(network(() => ({ body: '<html>Login</html>', headers: { 'content-type': 'application/pdf' } })).options).pdf('https://public.example/paper.pdf'), /不是有效的 PDF/);
  await assert.rejects(createSourceService(network(() => ({ headers: { 'content-length': String(50 * 1024 * 1024 + 1) } })).options).pdf('https://public.example/paper.pdf'), /50 MB/);
  const internal = network(() => ({ status: 302, headers: { location: 'http://[::1]/secret' } }));
  await assert.rejects(createSourceService(internal.options).pdf('https://public.example/paper.pdf'), /公开 HTTP/);
  assert.equal(internal.calls.length, 1);
  const direct = await createSourceService(network(() => ({ headers: { 'content-type': 'application/pdf', 'content-length': String(3 * 1024 * 1024) } })).options).resolve('https://public.example/download?id=123');
  assert.equal(direct.pdfUrl, 'https://public.example/download?id=123');
  assert.equal(direct.kind, 'paper');
  assert.match(direct.warning, /取得文件后/);
});

function call(port, path, { body = { url: 'https://article.example/post' }, headers = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1:8787', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', 'X-Papertrail-Token': 'local-token', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('来源 API 在无模型密钥时可用，主处理器先校验来源/token，错误为 JSON', async () => {
  const net = network(() => ({ body: '<title>Article</title>' }));
  const handler = createAIHandler({ env: {}, localToken: 'local-token', sourceOptions: net.options });
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const result = await call(port, '/api/sources/resolve');
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.bytes).title, 'Article');
    assert.match(result.headers['content-type'], /application\/json/);
    const count = net.calls.length;
    assert.equal((await call(port, '/api/sources/resolve', { headers: { 'X-Papertrail-Token': 'wrong' } })).status, 403);
    assert.equal((await call(port, '/api/sources/resolve', { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal(net.calls.length, count);
    for (const [options, expected] of [[{ body: '{' }, 400], [{ body: {} }, 400], [{ body: { url: 'file:///secret' } }, 400], [{ method: 'GET' }, 405], [{ headers: { 'Content-Type': 'text/plain' } }, 415]]) {
      const error = await call(port, '/api/sources/resolve', options);
      assert.equal(error.status, expected);
      assert.equal(typeof JSON.parse(error.bytes).error, 'string');
    }
    assert.equal((await call(port, '/api/sources/resolve?url=anything')).status, 404);
  } finally { server.closeAllConnections(); await handler.stop(); await new Promise(resolve => server.close(resolve)); }
});
