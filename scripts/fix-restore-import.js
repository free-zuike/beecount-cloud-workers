const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'lib', 'restore-service.ts');
let content = fs.readFileSync(filePath, 'utf8');

// Remove the leftover old code block (the else branch for non-replace + try/catch)
const oldBlock = `    }
        } else {
          await db.prepare(\`INSERT INTO "\${tableName}" (\${matchedColumns.map(c => \`"\${c}"\`).join(',')}) VALUES (\${matchedColumns.map(() => '?').join(',')})\`)
            .bind(...values).run();
        }
        importedCount++;
      } catch (err) {
        const msg = \`[Restore] \${tableName}: \${(err as Error).message}\`;
        console.error(msg);
        errors.push(msg);
      }
    }
    }`;

if (content.includes(oldBlock)) {
  content = content.replace(oldBlock, '}\n    }');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Fixed');
} else {
  console.log('Old block not found, checking file...');
  // Find the line numbers of the problematic code
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('importedCount++') && i > 200) {
      console.log(`Line ${i + 1}: ${lines[i]}`);
    }
  }
}