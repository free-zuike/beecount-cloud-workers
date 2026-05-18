const fs = require('fs');

const htmlPath = './src/frontend/index.html';
let html = fs.readFileSync(htmlPath, 'utf8');

// 提取 JavaScript 代码部分
const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.lastIndexOf('</script>');
let js = html.substring(scriptStart, scriptEnd);

// 将模板字符串转换为字符串拼接
// 匹配: `template ${var} string`
js = js.replace(/`([^`]*)`/g, (match, content) => {
  // 如果是简单的模板字符串（没有复杂的嵌套），转换为字符串拼接
  // 简化处理：如果包含 ${}，则转换
  if (content.includes('${')) {
    // 提取变量部分
    const parts = content.split(/\$\{([^}]+)\}/);
    if (parts.length > 1) {
      let result = "'" + parts[0];
      for (let i = 1; i < parts.length; i += 2) {
        const expr = parts[i];
        const next = parts[i + 1] || '';
        result += "' + (" + expr + ") + '" + next;
      }
      return result + "'";
    }
  }
  // 没有变量的模板字符串，转换为普通字符串
  return "'" + content + "'";
});

// 放回 HTML
const newHtml = html.substring(0, scriptStart) + js + html.substring(scriptEnd);

fs.writeFileSync(htmlPath, newHtml);
console.log('Converted template literals in HTML');
