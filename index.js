'use strict';

const http = require('http');
const https = require('https');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');

// ── Credentials (from environment variables) ──────────────────────────────────
const SHOP = process.env.SHOPIFY_SHOP || 'ciro-jewelry.myshopify.com';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ACTIVE_THEME_ID = process.env.SHOPIFY_ACTIVE_THEME_ID || '161795899724';
const API_VERSION = '2026-04';
const PORT = process.env.PORT || 3457;

if (!TOKEN) {
  console.error('ERROR: SHOPIFY_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

// ── Shopify REST helper ───────────────────────────────────────────────────────
function shopifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: SHOP,
      port: 443,
      path: `/admin/api/${API_VERSION}/${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Shopify API ${res.statusCode}: ${data}`));
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'shopify-theme-editor', version: '1.0.0' });

server.tool('shopify_list_themes', 'List all Shopify themes with ID, name, and role', {}, async () => {
  const data = await shopifyRequest('GET', 'themes.json');
  const themes = data.themes.map((t) => ({ id: String(t.id), name: t.name, role: t.role, updated_at: t.updated_at }));
  return { content: [{ type: 'text', text: JSON.stringify(themes, null, 2) }] };
});

server.tool('shopify_get_active_theme', 'Get the currently active/published Shopify theme', {}, async () => {
  const data = await shopifyRequest('GET', 'themes.json?role=main');
  return { content: [{ type: 'text', text: JSON.stringify(data.themes[0] || null, null, 2) }] };
});

server.tool('shopify_list_theme_files', 'List all files/assets in a Shopify theme', {
  theme_id: z.string().optional().describe('Theme ID (defaults to active theme)'),
}, async ({ theme_id }) => {
  const id = theme_id || ACTIVE_THEME_ID;
  const data = await shopifyRequest('GET', `themes/${id}/assets.json`);
  const files = data.assets.map((a) => ({ key: a.key, size: a.size, updated_at: a.updated_at }));
  return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
});

server.tool('shopify_read_file', 'Read the content of a theme file/asset', {
  key: z.string().describe('File key, e.g. "sections/header.liquid"'),
  theme_id: z.string().optional().describe('Theme ID (defaults to active theme)'),
}, async ({ key, theme_id }) => {
  const id = theme_id || ACTIVE_THEME_ID;
  const data = await shopifyRequest('GET', `themes/${id}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  const content = data.asset.value || data.asset.attachment || '(binary or no content)';
  return { content: [{ type: 'text', text: content }] };
});

server.tool('shopify_write_file', 'Write or update a theme file/asset with new content', {
  key: z.string().describe('File key, e.g. "sections/header.liquid"'),
  value: z.string().describe('The full file content to write'),
  theme_id: z.string().optional().describe('Theme ID (defaults to active theme)'),
}, async ({ key, value, theme_id }) => {
  const id = theme_id || ACTIVE_THEME_ID;
  const data = await shopifyRequest('PUT', `themes/${id}/assets.json`, { asset: { key, value } });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, key: data.asset.key, updated_at: data.asset.updated_at }, null, 2) }] };
});

server.tool('shopify_duplicate_theme', 'Duplicate a theme as a backup copy', {
  theme_id: z.string().describe('ID of the theme to duplicate'),
  new_name: z.string().describe('Name for the duplicated theme'),
}, async ({ theme_id, new_name }) => {
  const newThemeData = await shopifyRequest('POST', 'themes.json', {
    theme: { name: new_name, role: 'unpublished', src: `https://${SHOP}/admin/themes/${theme_id}/duplicate` },
  });
  const t = newThemeData.theme;
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, new_theme: { id: String(t.id), name: t.name } }, null, 2) }] };
});

server.tool('shopify_get_theme_settings', 'Read config/settings_data.json from a theme', {
  theme_id: z.string().optional().describe('Theme ID (defaults to active theme)'),
}, async ({ theme_id }) => {
  const id = theme_id || ACTIVE_THEME_ID;
  const data = await shopifyRequest('GET', `themes/${id}/assets.json?asset[key]=config%2Fsettings_data.json`);
  return { content: [{ type: 'text', text: data.asset.value || '(empty)' }] };
});

// ── HTTP server with SSE transport ────────────────────────────────────────────
const transports = {};

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'shopify-mcp', shop: SHOP }));
    return;
  }

  if (req.method === 'GET' && req.url === '/sse') {
    const transport = new SSEServerTransport('/message', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => { delete transports[transport.sessionId]; });
    await server.connect(transport);
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/message')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = urlObj.searchParams.get('sessionId');
    const transport = transports[sessionId];
    if (!transport) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[shopify-mcp] Running on port ${PORT} | Shop: ${SHOP}`);
});

process.on('SIGINT', () => { httpServer.close(); process.exit(0); });
process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });
