import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({
  command: process.execPath, args: [new URL('../src/index.js', import.meta.url).pathname],
  env: { ...process.env, GRAVITYKIT_MCP_LIST_TIMEOUT_MS: process.argv[2] },
  stderr: 'pipe',
});
let log = '';
const c = new Client({ name: 'probe', version: '1' }, { capabilities: {} });
await c.connect(t);
t.stderr?.on('data', d => { log += d.toString(); });
const names = (await c.listTools()).tools.map(x => x.name);
await new Promise(r => setTimeout(r, 800));
console.log(`  timeout=${process.argv[2]}ms  gv_* advertised: ${names.filter(n => n.startsWith('gv_')).length}`);
const warn = log.split('\n').find(l => l.includes('shipping WITHOUT'));
console.log('  loud warning:', warn ? 'FIRED' : 'not present');
if (warn) console.log('   ', warn.trim().slice(0, 190));
await c.close();
