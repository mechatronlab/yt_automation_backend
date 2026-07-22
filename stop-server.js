const { exec } = require('child_process');

const ports = [5001, 5002];

console.log('Scanning for dangling processes on ports:', ports);

ports.forEach(port => {
  exec(`lsof -t -i:${port}`, (err, stdout) => {
    if (err || !stdout.trim()) {
      console.log(`No process found running on port ${port}.`);
      return;
    }
    const pids = stdout.trim().split('\n').map(Number).filter(n => n > 0);
    console.log(`Found dangling processes on port ${port}:`, pids);
    
    pids.forEach(pid => {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`Successfully killed process ${pid} on port ${port}`);
      } catch (e) {
        console.log(`Failed to kill process ${pid}: ${e.message}`);
      }
    });
  });
});

