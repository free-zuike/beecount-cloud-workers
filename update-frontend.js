const fs = require('fs');

const indexPath = './src/index.ts';
const htmlPath = './src/frontend/index.html';

let indexContent = fs.readFileSync(indexPath, 'utf8');
let htmlContent = fs.readFileSync(htmlPath, 'utf8');

// 找到 "const FRONTEND_HTML = `"
const startMarker = 'const FRONTEND_HTML = `';
const startIndex = indexContent.indexOf(startMarker);

if (startIndex === -1) {
  console.error('Start marker not found');
  process.exit(1);
}

// 找到 "import { Hono } from 'hono';" - 在 startIndex 之后的那个
const endMarker = "import { Hono } from 'hono';";
const endIndexAfter = indexContent.indexOf(endMarker, startIndex + startMarker.length);

if (endIndexAfter === -1) {
  console.error('End marker not found after start');
  process.exit(1);
}

// 向前查找最近的 ` 在 endIndexAfter 之前
let backtickBefore = indexContent.lastIndexOf('`', endIndexAfter);
if (backtickBefore === -1 || backtickBefore < startIndex) {
  console.error('Backtick not found before end marker');
  process.exit(1);
}

// endIndex 应该是 `; 之后的位置
let actualEndIndex = backtickBefore + 2; // `; 的长度

console.log('Start: ' + startIndex + ', End: ' + actualEndIndex);
console.log('Original block length: ' + (actualEndIndex - startIndex - startMarker.length));
console.log('New HTML content length: ' + htmlContent.length);

// 提取前面的内容
const before = indexContent.substring(0, startIndex + startMarker.length);

// 提取后面的内容
const after = indexContent.substring(actualEndIndex);

// 新的内容：前面 + 开始标记 + HTML内容 + 结束标记 + 后面
const newContent = before + '\n' + htmlContent + '\n' + '`;\n\n' + after;

fs.writeFileSync(indexPath, newContent);
console.log('Successfully replaced FRONTEND_HTML');
console.log('New file length:', newContent.length);
console.log('New file lines:', newContent.split('\n').length);
