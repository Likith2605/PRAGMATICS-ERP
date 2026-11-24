import 'dotenv/config';
import { spawn } from 'node:child_process';

const host = '127.0.0.1';
const port = Number(process.env.PORT) || 3001;
const healthUrl = `http://${host}:${port}/api/health`;
const customerPoUrl = `http://${host}:${port}/api/customer-purchase-orders`;
const viteArgs = ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)];
let backend;
let frontend;
let stopping = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const backendReady = async () => {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const routeResponse = await fetch(customerPoUrl, { signal: AbortSignal.timeout(1000) });
    return [200, 401, 403].includes(routeResponse.status);
  } catch {
    return false;
  }
};

const backendHealthy = async () => {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
};

const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of [frontend, backend]) {
    if (child && child.exitCode == null) child.kill('SIGTERM');
  }
  process.exitCode = code;
};

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (await backendHealthy()) {
  if (!(await backendReady())) {
    console.error(`An Express API is responding at ${healthUrl}, but it does not expose ${customerPoUrl}. Stop or restart that stale API process, then run the development server again.`);
    stop(1);
  } else {
    console.log(`Using existing Express API at ${healthUrl}`);
  }
} else {
  backend = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: process.env });
  backend.once('error', (error) => {
    console.error(`Could not start the Express API: ${error.message}`);
    stop(1);
  });
  backend.once('exit', (code) => {
    if (!stopping) {
      console.error(`Express API exited before development shutdown (code ${code ?? 'unknown'}).`);
      stop(code || 1);
    }
  });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await backendReady()) {
      ready = true;
      break;
    }
    if (backend.exitCode != null) break;
    await wait(250);
  }
  if (!ready) {
    console.error(`Express API did not become ready with the Customer Purchase Orders route at ${healthUrl}.`);
    stop(1);
  }
}

if (!stopping) {
  frontend = spawn(process.execPath, viteArgs, { stdio: 'inherit', env: process.env });
  frontend.once('error', (error) => {
    console.error(`Could not start Vite: ${error.message}`);
    stop(1);
  });
  frontend.once('exit', (code) => stop(code || 0));
}
