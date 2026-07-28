const { execSync } = require('child_process');
try {
    execSync('git add -A', {stdio: 'inherit'});
    execSync('git commit -m "fix: revert to simple AES-GCM encryption for backup (.enc format)"', {stdio: 'inherit'});
    execSync('git push origin main', {stdio: 'inherit'});
    console.log('Success!');
} catch (e) {
    console.error('Error:', e.message);
}
