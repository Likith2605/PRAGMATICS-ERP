import os from 'os';

const port = process.env.PORT || 3001;
const qcPort = process.env.QC_PORT || 4000;
const nets = os.networkInterfaces();
const ips = [];

for (const [name, addrs] of Object.entries(nets)) {
  for (const net of addrs) {
    if (net.family === 'IPv4' && !net.internal) {
      ips.push({ name, address: net.address });
    }
  }
}

console.log('');
console.log('==========================================================');
console.log('  PRAGMATICS ERP IS RUNNING IN PRODUCTION MODE');
console.log('==========================================================');
console.log('');
console.log('  On this server computer:');
console.log(`    Open in browser: http://localhost:${port}`);
console.log('');
console.log('  On other office computers (connected to office LAN):');
if (ips.length > 0) {
  for (const { name, address } of ips) {
    console.log(`    [${name}] http://${address}:${port}`);
  }
} else {
  console.log('    [!] No LAN IPv4 detected. Ensure server is connected to the office router.');
}
console.log('');
console.log('  QualityApp Mobile Devices (Shop Floor Wi-Fi):');
if (ips.length > 0) {
  for (const { name, address } of ips) {
    console.log(`    [${name}] Mobile Server URL: http://${address}:${qcPort}`);
  }
} else {
  console.log(`    Mobile Server URL: http://localhost:${qcPort}`);
}
console.log('');
console.log('  Database health check:');
console.log(`    http://localhost:${port}/api/health`);
console.log('');
console.log('  IMPORTANT:');
console.log('  * Keep this window OPEN while the office is operating.');
console.log('  * To STOP the server: press Ctrl+C or close this window.');
console.log('==========================================================');
console.log('');
