const { execSync } = require('child_process');
execSync('git add -A', {stdio: 'inherit'});
execSync('git commit -m "fix: sync full check budget projection"', {stdio: 'inherit'});
execSync('git push origin main', {stdio: 'inherit'});