fetch('https://beecount.qzz.io/api/v1/mcp/messages/', {
  method: 'POST',
  headers: { Authorization: 'Bearer bcmcp_JQ3dDvsXN59OEs-aC6hrZXqAjBxUZhvAqp1RpHJ7qBc', 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: '1', params: { name: 'list_ledgers', arguments: {} } })
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2))).catch(e => console.log('Error:', e.message))