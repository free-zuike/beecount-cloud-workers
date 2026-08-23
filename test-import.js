const fs = require('fs');
const path = require('path');

// 创建测试 CSV
const csv = '日期,时间,类型,金额,币种,账户,分类,标签,备注\n2026-07-30,15:56:00,expense,1000,CNY,web2app2,web2app,语音记账,\n2026-07-28,13:25:11,expense,3,CNY,web2app,早餐,美团,app2web11\n';

const boundary = '----TestBoundary' + Date.now();
const body = [
  `--${boundary}`,
  'Content-Disposition: form-data; name="file"; filename="test.csv"',
  'Content-Type: text/csv',
  '',
  csv.trim(),
  `--${boundary}--`,
  '',
].join('\r\n');

const https = require('https');
const options = {
  hostname: 'beecount.qzz.io',
  path: '/api/v1/import/upload',
  method: 'POST',
  headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': Buffer.byteLength(body),
    'Authorization': 'Bearer bcmcp_JQ3dDvsXN59OEs-aC6hrZXqAjBxUZhvAqp1RpHJ7qBc',
  },
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers));
    try {
      const parsed = JSON.parse(data);
      console.log('Tags mapping:', parsed.suggested_mapping?.tags);
      console.log('Sample tx tag_names:', parsed.sample_transactions?.map(t => t.tag_names));
      console.log('Response OK');
    } catch {
      console.log('Raw response:', data.substring(0, 500));
    }
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();