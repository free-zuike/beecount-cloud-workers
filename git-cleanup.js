const fs = require('fs');
const { execSync } = require('child_process');
try { fs.unlinkSync('E:\\Code\\beecount-cloud-workers\\cleanup-temp.cmd'); } catch(e) {}
try { fs.unlinkSync('E:\\Code\\beecount-cloud-workers\\git-commit.js'); } catch(e) {}
try { fs.unlinkSync('E:\\Code\\beecount-cloud-workers\\cleanup-commit.js'); } catch(e) {}
execSync('git add -A', {stdio: 'inherit'});
execSync('git commit -m "chore: remove temp files"', {stdio: 'inherit'});
execSync('git push origin main', {stdio: 'inherit'});