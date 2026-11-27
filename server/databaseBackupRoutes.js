import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, requireDepartmentPermission } from './auth.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const forbidden = (message) => Object.assign(new Error(message), { status: 403 });
const notFound = () => Object.assign(new Error('PostgreSQL backup not found.'), { status: 404 });
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const restoreEnabled = () => process.env.NODE_ENV === 'production'
  && process.env.ERP_TEST_MODE !== '1'
  && process.env.ERP_ALLOW_POSTGRES_RESTORE === 'true'
  && process.env.ERP_POSTGRES_RESTORE_MAINTENANCE_CONFIRMED === 'true';

const backupDirectory = () => {
  const configured = String(process.env.ERP_POSTGRES_BACKUP_DIR || '').trim();
  if (!configured) throw Object.assign(new Error('ERP_POSTGRES_BACKUP_DIR is not configured on the server.'), { status: 503 });
  return resolve(configured);
};

const runtimeDatabaseUrl = () => process.env.ERP_TEST_MODE === '1'
  ? process.env.ERP_TEST_DATABASE_URL
  : process.env.DATABASE_URL;

const connectionOptions = () => {
  const connectionString = runtimeDatabaseUrl();
  if (!connectionString) throw Object.assign(new Error('PostgreSQL connection is not configured for backup operations.'), { status: 503 });
  let url;
  try { url = new URL(connectionString); } catch { throw Object.assign(new Error('PostgreSQL connection configuration is invalid.'), { status: 503 }); }
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.ERP_TEST_DATABASE_URL;
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || '5432';
  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  env.PGAPPNAME = 'erp-postgresql-backup';
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;
  else if (process.env.DATABASE_SSL === 'true') env.PGSSLMODE = 'require';
  return env;
};

const findTool = async (name) => {
  const override = String(process.env[`ERP_${name.toUpperCase()}_PATH`] || '').trim();
  if (override) {
    try { await access(override, constants.X_OK); return override; } catch { return override; }
  }
  if (process.platform === 'win32') {
    const root = join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
    try {
      const versions = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const version of versions) {
        const candidate = join(root, version, 'bin', `${name}.exe`);
        try { await access(candidate, constants.X_OK); return candidate; } catch { /* Continue to the next installed version. */ }
      }
    } catch { /* Fall back to the executable available on PATH. */ }
  }
  return name;
};

const runTool = async (name, args, { captureOutput = false } = {}) => {
  const executable = await findTool(name);
  const env = connectionOptions();
  return new Promise((resolvePromise, rejectPromise) => {
    let captured = '';
    let settled = false;
    let child;
    try {
      child = spawn(executable, args, {
        env,
        shell: false,
        stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'ignore']
      });
    } catch {
      rejectPromise(Object.assign(new Error('PostgreSQL backup utility could not be started.'), { status: 503 }));
      return;
    }
    if (captureOutput) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (captured.length < 2048) captured += chunk.slice(0, 2048 - captured.length); });
    }
    child.on('error', () => {
      if (settled) return;
      settled = true;
      rejectPromise(Object.assign(new Error('PostgreSQL backup utility is unavailable on the server.'), { status: 503 }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        rejectPromise(Object.assign(new Error(`PostgreSQL ${name} operation failed (exit ${code}).`), { status: 500 }));
        return;
      }
      resolvePromise(captured);
    });
  });
};

const identity = async () => {
  const result = await getPool().query(
    `SELECT current_database() AS database_name,
            COALESCE(inet_server_addr()::text,'local') AS server_address,
            COALESCE(inet_server_port(),0) AS server_port`
  );
  const row = result.rows[0];
  return createHash('sha256')
    .update(`${row.database_name}\0${row.server_address}\0${row.server_port}`)
    .digest('hex');
};

const fileFor = (id, suffix) => {
  if (!idPattern.test(String(id || ''))) throw bad('A valid backup ID is required.');
  return join(backupDirectory(), `${id}${suffix}`);
};

const readMetadata = async (id) => {
  try {
    const metadata = JSON.parse(await readFile(fileFor(id, '.meta.json'), 'utf8'));
    if (metadata.id !== id || !/^[a-f0-9]{64}$/i.test(metadata.sha256)
      || !Number.isSafeInteger(Number(metadata.byteSize)) || Number(metadata.byteSize) < 1) {
      throw new Error('Invalid metadata');
    }
    return metadata;
  } catch (error) {
    if (error?.code === 'ENOENT') throw notFound();
    throw Object.assign(new Error('Backup metadata could not be read.'), { status: 500 });
  }
};

const hashFile = async (filename) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};

const writeMetadata = async (metadata) => {
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = fileFor(metadata.id, '.meta.json');
  const temporary = fileFor(metadata.id, `.meta-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(metadata, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
};

const publicMetadata = (metadata) => ({
  id: metadata.id,
  createdAt: metadata.createdAt,
  createdBy: metadata.createdBy,
  byteSize: Number(metadata.byteSize),
  sha256: metadata.sha256,
  integrityStatus: metadata.integrityStatus,
  verifiedAt: metadata.verifiedAt || null,
  verifiedBy: metadata.verifiedBy || '',
  identityFingerprint: metadata.identityFingerprint,
  preRestore: Boolean(metadata.preRestore),
  lastRestoreAt: metadata.lastRestoreAt || null,
  lastRestoreBy: metadata.lastRestoreBy || ''
});

const createBackup = async (actor, preRestore = false) => {
  const id = randomUUID();
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = fileFor(id, '.dump');
  try {
    await runTool('pg_dump', [
      '--format=custom', '--no-owner', '--no-acl', '--no-password', '--file', filename
    ]);
    const fileStat = await stat(filename);
    if (!fileStat.size) throw Object.assign(new Error('PostgreSQL produced an empty backup file.'), { status: 500 });
    await runTool('pg_restore', ['--list', '--no-password', filename], { captureOutput: true });
    const metadata = {
      id,
      createdAt: new Date().toISOString(),
      createdBy: actor,
      byteSize: fileStat.size,
      sha256: await hashFile(filename),
      integrityStatus: 'VERIFIED',
      verifiedAt: new Date().toISOString(),
      verifiedBy: 'server',
      identityFingerprint: await identity(),
      preRestore
    };
    await writeMetadata(metadata);
    return metadata;
  } catch (error) {
    try { await unlink(filename); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
    throw error;
  }
};

const verifyBackup = async (metadata, verifiedBy = 'server') => {
  const filename = fileFor(metadata.id, '.dump');
  const fileStat = await stat(filename).catch((error) => {
    if (error?.code === 'ENOENT') throw notFound();
    throw error;
  });
  try {
    const checksum = await hashFile(filename);
    if (Number(fileStat.size) !== Number(metadata.byteSize) || checksum !== metadata.sha256) {
      throw conflict('Backup integrity check failed: size or SHA-256 checksum differs from its metadata.');
    }
    await runTool('pg_restore', ['--list', '--no-password', filename], { captureOutput: true });
  } catch (error) {
    if (error.status !== 503) {
      await writeMetadata({
        ...metadata,
        integrityStatus: 'FAILED',
        verifiedAt: new Date().toISOString(),
        verifiedBy
      });
    }
    throw error;
  }
  const updated = { ...metadata, integrityStatus: 'VERIFIED', verifiedAt: new Date().toISOString(), verifiedBy };
  await writeMetadata(updated);
  return updated;
};

router.get('/status', requireDepartmentPermission('backup.view'), async (_req, res) => {
  res.json({
    identityFingerprint: await identity(),
    backupDirectoryConfigured: Boolean(String(process.env.ERP_POSTGRES_BACKUP_DIR || '').trim()),
    restoreEnabled: restoreEnabled()
  });
});

router.get('/', requireDepartmentPermission('backup.view'), async (_req, res) => {
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = await readdir(directory);
  const metadataFiles = files.filter((name) => /^[0-9a-f-]{36}\.meta\.json$/i.test(name));
  const records = await Promise.all(metadataFiles.map(async (name) => {
    const id = name.slice(0, -'.meta.json'.length);
    return publicMetadata(await readMetadata(id));
  }));
  records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  res.json({ records });
});

router.post('/', requireAdmin, async (req, res) => {
  const metadata = await createBackup(req.user.email);
  res.status(201).json({ backup: publicMetadata(metadata) });
});

router.get('/:id/download', requireAdmin, async (req, res) => {
  const metadata = await readMetadata(req.params.id);
  const filename = fileFor(metadata.id, '.dump');
  await stat(filename).catch((error) => { if (error?.code === 'ENOENT') throw notFound(); throw error; });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="erp-postgres-backup-${metadata.id}.dump"`);
  createReadStream(filename).pipe(res);
});

router.post('/:id/verify', requireAdmin, async (req, res) => {
  const metadata = await readMetadata(req.params.id);
  const verified = await verifyBackup(metadata, req.user.email);
  res.json({ backup: publicMetadata(verified) });
});

router.post('/:id/restore', requireAdmin, async (req, res) => {
  if (!restoreEnabled()) {
    throw forbidden('PostgreSQL restore is disabled outside an explicitly enabled production recovery window.');
  }
  const metadata = await readMetadata(req.params.id);
  const currentIdentity = await identity();
  if (metadata.identityFingerprint !== currentIdentity) {
    throw conflict('Backup database identity does not match the currently connected database.');
  }
  if (text(req.body?.confirmation) !== `RESTORE ${metadata.id}`
    || text(req.body?.identityFingerprint) !== currentIdentity
    || !text(req.body?.reason)
    || text(req.body?.reason).length > 1000) {
    throw bad('Explicit backup ID, database identity confirmation and restore reason are required.');
  }
  const verified = await verifyBackup(metadata);
  const safetyBackup = await createBackup(req.user.email, true);
  const restoreAudit = {
    requestedAt: new Date().toISOString(),
    requestedBy: req.user.email,
    reason: text(req.body.reason),
    targetBackupId: verified.id,
    safetyBackupId: safetyBackup.id,
    identityFingerprint: currentIdentity,
    status: 'IN_PROGRESS'
  };
  const auditFile = fileFor(verified.id, `.restore-${randomUUID()}.json`);
  await writeFile(auditFile, JSON.stringify(restoreAudit, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    await runTool('pg_restore', [
      '--clean', '--if-exists', '--exit-on-error', '--single-transaction',
      '--no-owner', '--no-acl', '--no-password', fileFor(verified.id, '.dump')
    ]);
    restoreAudit.status = 'SUCCEEDED';
    restoreAudit.completedAt = new Date().toISOString();
    await writeFile(auditFile, JSON.stringify(restoreAudit, null, 2), { mode: 0o600 });
    res.json({ restored: true, backupId: verified.id, safetyBackupId: safetyBackup.id });
  } catch (error) {
    restoreAudit.status = 'FAILED';
    restoreAudit.completedAt = new Date().toISOString();
    await writeFile(auditFile, JSON.stringify(restoreAudit, null, 2), { mode: 0o600 });
    throw error;
  }
});

const text = (value) => String(value ?? '').trim();

export default router;
