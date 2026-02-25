'use strict';

const https = require('https');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const SHOP = process.env.SHOPIFY_SHOP || 'ciro-jewelry.myshopify.com';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ACTIVE_THEME_ID = process.env.SHOPIFY_ACTIVE_THEME_ID || '161795899724';
const API_VERSION = '2026-04';

if (!TOKEN) { process.stderr.write('ERROR: SHOPIFY_ACCESS_TOKEN required\n'); process.exit(1); }

function shopifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: SHOP, port: 443,
      path: `/admin/api/${API_VERSION}/${path}`,
      method,
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Shopify ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const server = new McpServer({ name: 'shopify-ciro', version: '1.0.0' });

server.tool('shopify_list_themes', 'List all Shopify themes', {}, async () => {
  const data = await shopifyRequest('GET', 'themes.json');
  const themes = data.themes.map(t => ({ id: String(t.id), name: t.name, role: t.role }));
  return { content: [{ type: 'text', text: JSON.stringify(themes, null, 2) }] };
});

server.tool('shopify_get_active_theme', 'Get the live/active theme', {}, async () => {
  const data = await shopifyRequest('GET', 'themes.json?role=main');
  return { content: [{ type: 'text', text: JSON.stringify(data.themes[0], null, 2) }] };
});

server.tool('shopify_list_theme_files', 'List all files in a theme', {
  theme_id: z.string().optional().describe('Theme ID (defaults to active theme)'),
}, async ({ theme_id }) => {
  const data = await shopifyRequest('GET', `themes/${theme_id || ACTIVE_THEME_ID}/assets.json`);
  return { content: [{ type: 'text', text: JSON.stringify(data.assets.map(a => a.key), null, 2) }] };
});

server.tool('shopify_read_file', 'Read a theme file', {
  key: z.string().describe('e.g. "sections/header.liquid"'),
  theme_id: z.string().optional(),
}, async ({ key, theme_id }) => {
  const data = await shopifyRequest('GET', `themes/${theme_id || ACTIVE_THEME_ID}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  return { content: [{ type: 'text', text: data.asset.value || '(binary)' }] };
});

server.tool('shopify_write_file', 'Write/update a theme file', {
  key: z.string().describe('e.g. "sections/header.liquid"'),
  value: z.string().describe('Full file content'),
  theme_id: z.string().optional(),
}, async ({ key, value, theme_id }) => {
  const data = await shopifyRequest('PUT', `themes/${theme_id || ACTIVE_THEME_ID}/assets.json`, { asset: { key, value } });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, key: data.asset.key, updated_at: data.asset.updated_at }) }] };
});

server.tool('shopify_duplicate_theme', 'Duplicate a theme as backup', {
  theme_id: z.string(),
  new_name: z.string(),
}, async ({ theme_id, new_name }) => {
  const data = await shopifyRequest('POST', 'themes.json', {
    theme: { name: new_name, role: 'unpublished', src: `https://${SHOP}/admin/themes/${theme_id}/duplicate` },
  });
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, id: String(data.theme.id), name: data.theme.name }) }] };
});

server.tool('shopify_get_theme_settings', 'Read theme settings (config/settings_data.json)', {
  theme_id: z.string().optional(),
}, async ({ theme_id }) => {
  const data = await shopifyRequest('GET', `themes/${theme_id || ACTIVE_THEME_ID}/assets.json?asset[key]=config%2Fsettings_data.json`);
  return { content: [{ type: 'text', text: data.asset.value || '(empty)' }] };
});

const transport = new StdioServerTransport();
server.connect(transport).catch(e => { process.stderr.write(String(e) + '\n'); process.exit(1); });
