/**
 * PostgreSQL integration coverage for the backend-first Enquiry module.
 *
 * Safety: requires ERP_TEST_DATABASE_URL and refuses database names other than
 * "vyavastha_test". The configured ERP DATABASE_URL is never used as a
 * fallback. Run with ERP_TEST_DATABASE_URL pointing to an isolated database.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { findEmbeddedLegacyDrawing } from '../src/utils/drawingStorage.js';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) {
    console.log('SKIP: ERP_TEST_DATABASE_URL is not configured; no database was contacted.');
    process.exit(0);
}
const parsedDbUrl = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsedDbUrl.pathname.replace(/^\//, ''));
if (databaseName !== 'vyavastha_test') throw new Error('Refusing to run: ERP_TEST_DATABASE_URL must point exactly to vyavastha_test.');
const pg = (await
    import ('pg')).default;
const testPool = new pg.Pool({ connectionString: databaseUrl });
const identity = await testPool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
    await testPool.end();
    throw new Error('Refusing to run: PostgreSQL current_database() is not vyavastha_test.');
}

const PORT = Number(process.env.ERP_TEST_PORT || 3337);
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let tokenA = '';
let tokenB = '';
let createdId = '';
let importedId = '';
let referenceRecordId = '';
let missingChecksumId = '';
let checksumFixtureProjectId = '';
let restrictedEmployeeId = '';
let restrictedEmployeeEmail = '';
let restrictedSessionHash = '';
let authorizedEmployeeId = '';
let authorizedEmployeeEmail = '';
let authorizedSessionHash = '';
let orphanFileId = '';
let passedCount = 0;
const api = async(path, token = tokenA, options = {}) => {
    const response = await fetch(`${BASE}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}`, 'X-ERP-Department': 'Sales Department' } : {}), ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
};
const startServer = async() => {
    const childEnv = {};
    for (const key of Object.keys(process.env)) {
        if (key !== 'DATABASE_URL') childEnv[key] = process.env[key];
    }
    child = spawn(process.execPath, ['server.js'], {
        env: { ...childEnv, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(PORT) },
        stdio: 'ignore'
    });
    for (let i = 0; i < 90; i += 1) {
        try {
            const response = await fetch(`${BASE}/api/health`);
            const health = await response.json();
            if (response.ok && health.ready && health.database?.migrations?.some((migration) => migration.version === '015_file_checksum_verification')) return;
        } catch { /* server starting */ }
        await wait(250);
    }
    throw new Error('Isolated ERP server did not become ready.');
};
const stopServer = async() => {
    if (!child) return;
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    child = null;
};
const login = async() => {
    const result = await api('/api/auth/login', '', {
        method: 'POST',
        body: JSON.stringify({
            email: process.env.ERP_ADMIN_EMAIL,
            password: process.env.ERP_ADMIN_PASSWORD,
            portal: 'admin'
        })
    });
    if (result.status !== 200 || !result.body.token) throw new Error(`Admin test login failed (${result.status}).`);
    return result.body.token;
};
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    passedCount += 1;
    console.log(`PASS ${message}`);
};

try {
    await startServer();
    const projectPage = await readFile(new URL('../src/pages/ProjectRequestPage.jsx', import.meta.url), 'utf8');
    const enquiryClient = await readFile(new URL('../src/services/enquiryApi.js', import.meta.url), 'utf8');
    const addEnquiryPage = await readFile(new URL('../src/pages/AddProjectRequestPage.jsx', import.meta.url), 'utf8');
    const bomPage = await readFile(new URL('../src/pages/BOMPage.jsx', import.meta.url), 'utf8');
    const projectTracker = await readFile(new URL('../src/utils/projectTracker.js', import.meta.url), 'utf8');
    const fileRoutes = await readFile(new URL('../server/fileRoutes.js', import.meta.url), 'utf8');
    assert(projectPage.includes('setProjects(authoritative)') && !projectPage.includes('setProjects(local'), 'refresh replaces the active list with PostgreSQL and never activates local cached rows');
    assert(/import\s*\{[^}]*\bExternalLink\b[^}]*\}\s*from\s*['"]lucide-react['"]/.test(projectPage), 'Customer Enquiry PDF preview imports its external-link icon');
    assert(projectPage.includes('target="_blank"') && projectPage.includes('rel="noopener noreferrer"') && projectPage.includes('URL.revokeObjectURL(blobUrl)'), 'PDF preview opens safely in a new tab and releases its Blob URL when closed');
    assert(projectPage.includes('download={previewDrawing.fileName}'), 'Enquiry drawing preview supports authenticated PDF download after PostgreSQL retrieval');
    assert(!enquiryClient.includes('export const cacheEnquiries'), 'Enquiry client has no local cache-to-active-state restore helper');
    assert(!addEnquiryPage.includes('if (item.drawingDataUrl) return item') && addEnquiryPage.includes("drawingSource: 'server'"), 'edit form strips embedded legacy drawing bytes and reloads saved attachments from PostgreSQL');
    assert(projectPage.includes('const handlePreviewDrawing = async (item, projectId)') && !bomPage.includes('item?.drawingDataUrl'), 'normal Enquiry and BOM previews cannot use embedded/local Enquiry drawing fallbacks');
    assert(projectPage.includes('useParams') && projectPage.includes('getEnquiry(routeProjectId)') && projectPage.includes('navigate(`/project-request/${encodeURIComponent(project.projectId)}`)'), 'View navigates to a stable enquiry URL and direct navigation loads its PostgreSQL record by ID');
    assert(projectPage.includes('const preview = await getEnquiryMigrationPreview()') && projectPage.includes('const authoritative = Array.isArray(preview.records)') && !projectPage.includes('Promise.all([listEnquiries(), getEnquiryMigrationPreview()])'), 'active list and migration review use the same PostgreSQL enquiry snapshot');
    assert(projectPage.includes('getEnquiryMigrationPreview()\n          .then((preview)') && projectPage.includes('setProjects(Array.isArray(preview.records) ? preview.records : [])'), 'a stale View link refreshes the authoritative list after PostgreSQL returns not found');
    assert(projectPage.includes('tombstonedEnquiryIds.has(String(project.projectId))'), 'legacy drawing recovery cannot bypass an Enquiry deletion tombstone');
    assert(enquiryClient.includes('export const getEnquiry') && fileRoutes.includes('linkedItem.drawingFileId'), 'enquiry detail API and persisted attachment reference are used for retrieval');
    assert(addEnquiryPage.includes('verifiedDrawings') && addEnquiryPage.includes('drawingFileId: attachment.id'), 'new drawing references are saved only after PostgreSQL read-back verification');
    assert(!projectTracker.includes("drawingDataUrl: it.drawingDataUrl || ''") && projectPage.includes('migrateLegacyEmbeddedDrawing'), 'embedded legacy bytes are retained only for explicit Admin recovery');
    assert(fileRoutes.includes("router.get('/integrity/checksum-review/inventory', requireAdmin") && fileRoutes.includes("router.post('/integrity/checksum-review/:id/verify', requireAdmin"), 'checksum inventory and backfill endpoints enforce Admin authorization');
    assert(fileRoutes.includes('ensureDrawingReference') && fileRoutes.includes("router.get('/', requireAdmin"), 'drawing access is permission-scoped and attachment inventory is Admin-only');
    const drawingStorage = await readFile(new URL('../src/utils/drawingStorage.js', import.meta.url), 'utf8');
    assert(drawingStorage.indexOf('getFileContentWithMetadata(id)') < drawingStorage.indexOf('const readCachedDrawing'), 'drawing display reads PostgreSQL binary content before any legacy IndexedDB migration helper');
    assert(drawingStorage.includes("stored.blob.type.toLowerCase() === 'application/pdf'") && drawingStorage.includes('%%EOF'), 'drawing preview rejects empty or malformed stored PDFs before opening them');
    const pdfFixture = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const embeddedCopy = `data:application/pdf;base64,${pdfFixture.toString('base64')}`;
    const recoveredCopy = findEmbeddedLegacyDrawing([
        { projectId: 'PE-LEGACY-1', items: [{ drawingNo: 'NA91KD', drawingDataUrl: embeddedCopy, drawingFileName: 'na91kd.pdf' }] },
        { projectId: 'PE-OTHER', items: [{ drawingNo: 'NA91KD', drawingDataUrl: 'data:application/pdf;base64,other' }] }
    ], 'PE-LEGACY-1', 'NA91KD');
    assert(recoveredCopy.status === 'available' && recoveredCopy.fileName === 'na91kd.pdf' && Buffer.from(recoveredCopy.dataUrl.split(',')[1], 'base64').equals(pdfFixture), 'legacy recovery selects actual embedded PDF bytes only for the exact enquiry and drawing');
    const ambiguousCopy = findEmbeddedLegacyDrawing([
        { projectId: 'PE-LEGACY-1', items: [{ drawingNo: 'NA91KD', drawingDataUrl: embeddedCopy }] },
        { id: 'PE-LEGACY-1', items: [{ drawingNo: 'NA91KD', drawingDataUrl: 'data:application/pdf;base64,different' }] }
    ], 'PE-LEGACY-1', 'NA91KD');
    assert(ambiguousCopy.status === 'ambiguous', 'conflicting embedded browser copies are not selected for migration');
    const drawingMigration = drawingStorage.slice(drawingStorage.indexOf('const migrateDrawingBytes'), drawingStorage.indexOf('export const deleteDrawing'));
    assert(drawingMigration.includes('ifAbsent: true') && drawingMigration.includes('verifyServerAttachment') && drawingMigration.includes('await sha256(blob)'), 'legacy drawing migration is create-only, verifies stored bytes, and retains the local copy');
    const health = await api('/api/health', '');
    assert(health.body?.database?.connected === true, 'isolated PostgreSQL database is connected');
    const untrackedDeletes = await testPool.query(
        `SELECT count(DISTINCT audit.record_id)::integer AS count
         FROM erp_audit_log audit
         WHERE audit.module='projectRequests' AND audit.action='DELETE'
           AND NOT EXISTS (SELECT 1 FROM module_records active WHERE active.storage_key='projectRequests' AND active.record_id=audit.record_id)
           AND NOT EXISTS (SELECT 1 FROM enquiry_tombstones tombstone WHERE tombstone.record_id=audit.record_id)`
    );
    assert(untrackedDeletes.rows[0].count === 0, 'historical Enquiry deletes are represented by tombstones after migration backfill');
    tokenA = await login();
    tokenB = await login();

    checksumFixtureProjectId = `PE-CHECKSUM-${randomUUID()}`;
    const checksumFixtureDrawingNo = `CHECKSUM-${randomUUID().slice(0, 8)}`;
    missingChecksumId = `drawing::${encodeURIComponent(checksumFixtureProjectId)}::${encodeURIComponent(checksumFixtureDrawingNo)}`;
    const checksumFixtureBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const checksumFixtureHash = createHash('sha256').update(checksumFixtureBytes).digest('hex');
    await testPool.query(
        `INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by)
         VALUES('projectRequests',$1,$2::jsonb,1,now(),'enquiry-test')`,
        [checksumFixtureProjectId, JSON.stringify({ projectId: checksumFixtureProjectId, items: [{ drawingNo: checksumFixtureDrawingNo, drawingFileName: 'checksum-fixture.pdf' }] })]
    );
    await testPool.query(
        `INSERT INTO file_blobs(id,file_name,mime_type,size_bytes,scope,metadata,content,checksum_sha256,uploaded_by)
         VALUES($1,'checksum-fixture.pdf','application/pdf',$2,'drawing',$3::jsonb,$4::bytea,NULL,'test-fixture')`,
        [missingChecksumId, checksumFixtureBytes.length, JSON.stringify({ projectId: checksumFixtureProjectId, drawingNo: checksumFixtureDrawingNo }), checksumFixtureBytes]
    );
    const inventory = await api('/api/files/integrity/checksum-review/inventory?limit=500', tokenA);
    assert(inventory.status === 200 && inventory.body.files.some((file) => file.id === missingChecksumId), 'Admin read-only inventory includes a missing-checksum attachment');
    const nonAdminInventory = await api('/api/files/integrity/checksum-review/inventory', '', { method: 'GET' });
    assert(nonAdminInventory.status === 401, 'checksum review inventory requires authentication');
    const checksumReview = await api(`/api/files/integrity/checksum-review/${encodeURIComponent(missingChecksumId)}`, tokenA);
    assert(checksumReview.status === 200 && checksumReview.body.id === missingChecksumId && checksumReview.body.contentBase64 && checksumReview.body.candidateChecksumSha256 === checksumFixtureHash, 'Admin review returns attachment identity, content, and candidate SHA-256 without changing it');
    const unconfirmedBackfill = await api(`/api/files/integrity/checksum-review/${encodeURIComponent(missingChecksumId)}/verify`, tokenA, { method: 'POST', body: JSON.stringify({ trustedOriginalSha256: checksumFixtureHash, verificationMethod: 'trusted_original_sha256', verificationReference: 'test trusted source', confirmed: false }) });
    assert(unconfirmedBackfill.status === 400, 'unverified attachment cannot receive checksum backfill');
    const mismatchBackfill = await api(`/api/files/integrity/checksum-review/${encodeURIComponent(missingChecksumId)}/verify`, tokenA, { method: 'POST', body: JSON.stringify({ trustedOriginalSha256: '0'.repeat(64), verificationMethod: 'trusted_original_sha256', verificationReference: 'test trusted source', confirmed: true }) });
    assert(mismatchBackfill.status === 409, 'mismatched trusted-original checksum is rejected');
    const blockedOverwrite = await api(`/api/files/${encodeURIComponent(missingChecksumId)}`, tokenA, { method: 'PUT', body: JSON.stringify({ fileName: 'replacement.pdf', mimeType: 'application/pdf', scope: 'drawing', metadata: { projectId: checksumFixtureProjectId, drawingNo: checksumFixtureDrawingNo }, contentBase64: checksumFixtureBytes.toString('base64') }) });
    assert(blockedOverwrite.status === 409, 'ordinary upload cannot overwrite a checksum-less existing attachment');
    const beforeBackfill = await testPool.query('SELECT content,checksum_sha256,updated_at FROM file_blobs WHERE id=$1', [missingChecksumId]);
    assert(beforeBackfill.rows[0].checksum_sha256 === null, 'inventory and review remain read-only until trusted verification succeeds');
    const approvedBackfill = await api(`/api/files/integrity/checksum-review/${encodeURIComponent(missingChecksumId)}/verify`, tokenA, { method: 'POST', body: JSON.stringify({ trustedOriginalSha256: checksumFixtureHash, verificationMethod: 'trusted_original_sha256', verificationReference: 'trusted-original-checksum-fixture.pdf', confirmed: true }) });
    const afterBackfill = await testPool.query('SELECT content,checksum_sha256,updated_at FROM file_blobs WHERE id=$1', [missingChecksumId]);
    assert(approvedBackfill.status === 200 && afterBackfill.rows[0].checksum_sha256 === checksumFixtureHash, 'confirmed trusted-original comparison stores the correct SHA-256');
    assert(Buffer.compare(beforeBackfill.rows[0].content, afterBackfill.rows[0].content) === 0 && beforeBackfill.rows[0].updated_at.getTime() === afterBackfill.rows[0].updated_at.getTime(), 'checksum backfill leaves attachment bytes and updated_at unchanged');
    const verificationEvidence = await testPool.query('SELECT verified_by,verified_by_email,verified_at,verification_method,verification_reference,content_checksum_sha256 FROM file_checksum_verifications WHERE file_id=$1 ORDER BY id DESC LIMIT 1', [missingChecksumId]);
    const checksumAudit = await testPool.query("SELECT 1 FROM erp_audit_log WHERE module='Files' AND record_id=$1 AND action='CHECKSUM_VERIFIED'", [missingChecksumId]);
    assert(verificationEvidence.rowCount === 1 && verificationEvidence.rows[0].verified_by && verificationEvidence.rows[0].verified_by_email && verificationEvidence.rows[0].verified_at && verificationEvidence.rows[0].verification_method === 'trusted_original_sha256' && verificationEvidence.rows[0].verification_reference === 'trusted-original-checksum-fixture.pdf' && checksumAudit.rowCount === 1, 'checksum verification records Admin, time, method, source reference, and audit history');

    const createToken = `enqtest-${randomUUID()}`;
    const data = {
        customerName: 'Persistence Test Contact',
        companyName: 'Persistence Test Company',
        requestedDate: new Date().toISOString().slice(0, 10),
        address: 'Isolated Test Address',
        items: [
            { itemName: 'Test Item', drawingNo: 'TEST-001', drawingFileName: 'test-001.pdf', quantity: 1, unit: 'Nos' },
            { itemName: 'Second Test Item', drawingNo: 'TEST-002', quantity: 2, unit: 'Nos' }
        ],
        createdAt: new Date().toISOString()
    };
    const created = await api('/api/enquiries', tokenA, { method: 'POST', body: JSON.stringify({ data, createToken, sequenceHint: 0 }) });
    assert(created.status === 201 && created.body.record?.projectId, 'create persists and returns a database-assigned enquiry ID');
    createdId = created.body.record.projectId;
    const detailRead = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenB);
    assert(detailRead.status === 200 && detailRead.body.record.projectId === createdId && detailRead.body.record.items.length === 2, 'direct enquiry detail endpoint retrieves all persisted item lines by ID');
    const missingDetail = await api('/api/enquiries/PE-MISSING-TEST', tokenB);
    assert(missingDetail.status === 404 && /not found in PostgreSQL/.test(missingDetail.body.error), 'missing enquiry detail returns an explicit PostgreSQL not-found response');
    const unauthenticatedDetail = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, '');
    assert(unauthenticatedDetail.status === 401, 'direct enquiry detail requires authentication');
    const retry = await api('/api/enquiries', tokenA, { method: 'POST', body: JSON.stringify({ data, createToken, sequenceHint: 0 }) });
    assert(retry.status === 200 && retry.body.idempotentReplay && retry.body.record.projectId === createdId, 'retry token does not create a duplicate');
    const tokenCount = await testPool.query("SELECT count(*)::integer AS count FROM module_records WHERE storage_key='projectRequests' AND create_token=$1", [createToken]);
    assert(tokenCount.rows[0].count === 1, 'idempotency token has exactly one PostgreSQL record');

    const list = await api('/api/enquiries', tokenB);
    assert(list.status === 200 && list.body.records.some((record) => record.projectId === createdId), 'second authenticated client reads the shared record');
    const databaseRow = await testPool.query("SELECT data,version FROM module_records WHERE storage_key='projectRequests' AND record_id=$1", [createdId]);
    assert(databaseRow.rowCount === 1 && databaseRow.rows[0].data.companyName === data.companyName, 'record exists in PostgreSQL module_records');
    const unauthenticatedDelete = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, '', { method: 'DELETE', body: JSON.stringify({ version: created.body.record.version, reason: 'Unauthorized test attempt' }) });
    assert(unauthenticatedDelete.status === 401, 'delete requires an authenticated Admin session');

    importedId = `PE-TEST-${randomUUID().slice(0, 8)}`;
    const legacyRecord = { projectId: importedId, customerName: 'Legacy Test Contact', companyName: 'Legacy Test Company', items: [{ itemName: 'Legacy Item', quantity: 2 }] };
    const imported = await api('/api/enquiries/migration-preview/import-missing', tokenA, { method: 'POST', body: JSON.stringify({ records: [legacyRecord] }) });
    assert(imported.status === 200 && imported.body.imported.includes(importedId), 'migration imports missing legacy IDs without renumbering');
    const exactReimport = await api('/api/enquiries/migration-preview/import-missing', tokenA, { method: 'POST', body: JSON.stringify({ records: [legacyRecord] }) });
    assert(exactReimport.body.alreadyPresent.includes(importedId) && exactReimport.body.imported.length === 0, 'reimport recognizes the same ID without duplication');
    const conflictingImport = await api('/api/enquiries/migration-preview/import-missing', tokenA, { method: 'POST', body: JSON.stringify({ records: [{...legacyRecord, companyName: 'Do Not Overwrite' }] }) });
    const importedRow = await testPool.query("SELECT data FROM module_records WHERE storage_key='projectRequests' AND record_id=$1", [importedId]);
    assert(conflictingImport.body.conflicts.some((entry) => entry.id === importedId) && importedRow.rows[0].data.companyName === legacyRecord.companyName, 'conflicting migration preserves PostgreSQL data');

    restrictedEmployeeId = `ENQ-ATTACH-${randomUUID()}`;
    restrictedEmployeeEmail = `${restrictedEmployeeId.toLowerCase()}@example.test`;
    const restrictedAssignments = [{ department: 'Purchase Department', role: 'Purchase Employee', roleKey: 'purchase_employee' }];
    await testPool.query(
        `INSERT INTO employees(id,employee_id,name,email,password_hash,active,department,role,role_key,department_assignments,payload,created_by,updated_by)
         VALUES($1,$1,'Attachment Permission Test',$2,'',true,'Purchase Department','Purchase Employee','purchase_employee',$3::jsonb,'{}'::jsonb,'enquiry-test','enquiry-test')`,
        [restrictedEmployeeId, restrictedEmployeeEmail, JSON.stringify(restrictedAssignments)]
    );
    const restrictedToken = `enquiry-file-${randomUUID()}`;
    restrictedSessionHash = createHash('sha256').update(restrictedToken).digest('hex');
    await testPool.query(
        `INSERT INTO erp_sessions(token_hash,user_id,email,display_name,role,role_key,department,employee_id,expires_at)
         VALUES($1,$2,$3,'Attachment Permission Test','Purchase Employee','purchase_employee','Purchase Department',$2,now()+interval '1 hour')`,
        [restrictedSessionHash, restrictedEmployeeId, restrictedEmployeeEmail]
    );
    authorizedEmployeeId = `ENQ-ACCESS-${randomUUID()}`;
    authorizedEmployeeEmail = `${authorizedEmployeeId.toLowerCase()}@example.test`;
    const authorizedAssignments = [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }];
    await testPool.query(
        `INSERT INTO employees(id,employee_id,name,email,password_hash,active,department,role,role_key,department_assignments,payload,created_by,updated_by)
         VALUES($1,$1,'Enquiry Attachment Access Test',$2,'',true,'Sales Department','Sales Employee','sales_employee',$3::jsonb,'{}'::jsonb,'enquiry-test','enquiry-test')`,
        [authorizedEmployeeId, authorizedEmployeeEmail, JSON.stringify(authorizedAssignments)]
    );
    const authorizedToken = `enquiry-file-authorized-${randomUUID()}`;
    authorizedSessionHash = createHash('sha256').update(authorizedToken).digest('hex');
    await testPool.query(
        `INSERT INTO erp_sessions(token_hash,user_id,email,display_name,role,role_key,department,employee_id,expires_at)
         VALUES($1,$2,$3,'Enquiry Attachment Access Test','Sales Employee','sales_employee','Sales Department',$2,now()+interval '1 hour')`,
        [authorizedSessionHash, authorizedEmployeeId, authorizedEmployeeEmail]
    );

    const fileId = `drawing::${encodeURIComponent(createdId)}::${encodeURIComponent('TEST-001')}`;
    const uploadDrawing = async(contentBase64) => api(`/api/files/${encodeURIComponent(fileId)}`, tokenA, { method: 'PUT', body: JSON.stringify({ fileName: 'TEST-001.pdf', mimeType: 'application/pdf', scope: 'drawing', metadata: { projectId: createdId, drawingNo: 'TEST-001' }, contentBase64 }) });
    const drawingBytesV1 = Buffer.from('%PDF-1.4\n% drawing-v1\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const drawingBytesV2 = Buffer.from('%PDF-1.4\n% drawing-v2-newer\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const drawingV1 = drawingBytesV1.toString('base64');
    const drawingV2 = drawingBytesV2.toString('base64');
    const invalidLink = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenA, {
        method: 'PUT',
        body: JSON.stringify({ data: { ...data, items: [{ ...data.items[0], drawingFileId: 'drawing::wrong::TEST-001' }, data.items[1]] }, version: created.body.record.version })
    });
    assert(invalidLink.status === 400, 'enquiry rejects a drawing file ID that does not match the enquiry and drawing');
    const missingFileLink = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenA, {
        method: 'PUT',
        body: JSON.stringify({ data: { ...data, items: [{ ...data.items[0], drawingFileId: fileId }, data.items[1]] }, version: created.body.record.version })
    });
    assert(missingFileLink.status === 400, 'enquiry does not persist an attachment reference before PostgreSQL has verified file bytes');
    const restrictedList = await api('/api/files', restrictedToken, { headers: { 'X-ERP-Department': 'Purchase Department' } });
    assert(restrictedList.status === 403, 'authenticated non-Admins cannot enumerate attachment metadata');
    const restrictedUpload = await api(`/api/files/${encodeURIComponent(fileId)}`, restrictedToken, { method: 'PUT', headers: { 'X-ERP-Department': 'Purchase Department' }, body: JSON.stringify({ fileName: 'TEST-001.pdf', mimeType: 'application/pdf', scope: 'drawing', metadata: { projectId: createdId, drawingNo: 'TEST-001' }, contentBase64: drawingV1 }) });
    assert(restrictedUpload.status === 403, 'authenticated users without Enquiry drawing permission cannot upload attachments');
    const restrictedMigration = await api(`/api/files/${encodeURIComponent(fileId)}`, restrictedToken, { method: 'PUT', headers: { 'X-ERP-Department': 'Purchase Department' }, body: JSON.stringify({ fileName: 'TEST-001.pdf', mimeType: 'application/pdf', scope: 'drawing', metadata: { projectId: createdId, drawingNo: 'TEST-001' }, contentBase64: drawingV1, ifAbsent: true }) });
    assert(restrictedMigration.status === 403, 'legacy local-copy migration requires Admin authorization');
    const unauthenticatedRead = await api(`/api/files/${encodeURIComponent(fileId)}`, '');
    assert(unauthenticatedRead.status === 401, 'PDF preview requires an authenticated session');
    const unauthenticatedBinaryRead = await fetch(`${BASE}/api/files/${encodeURIComponent(fileId)}/content`);
    assert(unauthenticatedBinaryRead.status === 401, 'binary PDF retrieval requires an authenticated session');
    const drawingSaved1 = await uploadDrawing(drawingV1);
    assert(drawingSaved1.status === 200, 'drawing attachment saves to PostgreSQL');
    const storedPdf = await testPool.query('SELECT file_name,mime_type,size_bytes,metadata,content,checksum_sha256 FROM file_blobs WHERE id=$1', [fileId]);
    assert(storedPdf.rowCount === 1 && storedPdf.rows[0].file_name === 'TEST-001.pdf' && storedPdf.rows[0].mime_type === 'application/pdf' && Number(storedPdf.rows[0].size_bytes) === drawingBytesV1.length && storedPdf.rows[0].metadata.projectId === createdId && storedPdf.rows[0].metadata.drawingNo === 'TEST-001' && Buffer.compare(storedPdf.rows[0].content, drawingBytesV1) === 0 && storedPdf.rows[0].checksum_sha256 === createHash('sha256').update(drawingBytesV1).digest('hex'), 'PostgreSQL persists PDF bytes, filename, MIME, size, enquiry linkage, and SHA-256');
    const restrictedRead = await api(`/api/files/${encodeURIComponent(fileId)}`, restrictedToken, { headers: { 'X-ERP-Department': 'Purchase Department' } });
    assert(restrictedRead.status === 403, 'authenticated users without Enquiry drawing permission cannot read an attachment');
    const restrictedBinaryRead = await fetch(`${BASE}/api/files/${encodeURIComponent(fileId)}/content`, { headers: { Authorization: `Bearer ${restrictedToken}`, 'X-ERP-Department': 'Purchase Department' } });
    assert(restrictedBinaryRead.status === 403, 'binary PDF retrieval enforces the same Enquiry attachment permissions');
    const missingBinaryRead = await fetch(`${BASE}/api/files/${encodeURIComponent(`drawing::${createdId}::MISSING`)}/content`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert(missingBinaryRead.status === 404, 'missing binary attachment returns a clear not-found response');
    const authorizedRead = await api(`/api/files/${encodeURIComponent(fileId)}`, authorizedToken);
    assert(authorizedRead.status === 200 && Buffer.compare(Buffer.from(authorizedRead.body.contentBase64, 'base64'), drawingBytesV1) === 0, 'authorized Enquiry users can preview the linked PostgreSQL PDF');
    const binaryRead = await fetch(`${BASE}/api/files/${encodeURIComponent(fileId)}/content`, { headers: { Authorization: `Bearer ${authorizedToken}`, 'X-ERP-Department': 'Sales Department' } });
    const binaryBytes = Buffer.from(await binaryRead.arrayBuffer());
    const binaryDisposition = binaryRead.headers.get('content-disposition') || '';
    assert(binaryRead.status === 200 && binaryRead.headers.get('content-type') === 'application/pdf' && binaryDisposition.includes('inline') && binaryDisposition.includes("filename*=UTF-8''TEST-001.pdf") && binaryBytes.length === drawingBytesV1.length && createHash('sha256').update(binaryBytes).digest('hex') === createHash('sha256').update(drawingBytesV1).digest('hex'), 'authenticated binary endpoint returns byte-identical PDF, MIME, and filename');
    const linkedData = {
        ...data,
        items: [{ ...data.items[0], drawingFileId: fileId }, data.items[1]]
    };
    const linkedEnquiry = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenA, {
        method: 'PUT',
        body: JSON.stringify({ data: linkedData, version: created.body.record.version })
    });
    assert(linkedEnquiry.status === 200 && linkedEnquiry.body.record.items[0].drawingFileId === fileId && !linkedEnquiry.body.record.items[1].drawingFileId, 'verified attachment ID is linked only to its matching enquiry drawing');
    const linkedDetail = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenB);
    assert(linkedDetail.status === 200 && linkedDetail.body.record.items[0].drawingFileId === fileId, 'linked attachment reference survives direct retrieval from a second session');
    const linkedDatabaseRow = await testPool.query("SELECT data FROM module_records WHERE storage_key='projectRequests' AND record_id=$1", [createdId]);
    assert(linkedDatabaseRow.rows[0].data.items[0].drawingFileId === fileId, 'verified drawing file ID is persisted in the PostgreSQL enquiry record');
    orphanFileId = `drawing::${encodeURIComponent(`PE-ORPHAN-${randomUUID()}`)}::${encodeURIComponent('ORPHAN-001')}`;
    await testPool.query(
        `INSERT INTO file_blobs(id,file_name,mime_type,size_bytes,scope,metadata,content,checksum_sha256,uploaded_by)
         VALUES($1,'orphan.pdf','application/pdf',$2,'drawing',$3::jsonb,$4::bytea,$5,'enquiry-test')`,
        [orphanFileId, drawingBytesV1.length, JSON.stringify({ projectId: orphanFileId.split('::')[1], drawingNo: 'ORPHAN-001' }), drawingBytesV1, createHash('sha256').update(drawingBytesV1).digest('hex')]
    );
    const unrelatedRead = await api(`/api/files/${encodeURIComponent(orphanFileId)}`, authorizedToken);
    assert(unrelatedRead.status === 404, 'authorized users cannot retrieve drawing files not linked to an active Enquiry');
    const invalidPdf = await api(`/api/files/${encodeURIComponent(fileId)}`, tokenA, { method: 'PUT', body: JSON.stringify({ fileName: 'TEST-001.pdf', mimeType: 'application/pdf', scope: 'drawing', metadata: { projectId: createdId, drawingNo: 'TEST-001' }, contentBase64: Buffer.from('not a PDF').toString('base64') }) });
    assert(invalidPdf.status === 400, 'PDF upload rejects content without PDF signature markers');
    const unrelatedDrawing = await api(`/api/files/${encodeURIComponent(`drawing::${encodeURIComponent(createdId)}::NOT-LINKED`)}`, tokenA, { method: 'PUT', body: JSON.stringify({ fileName: 'unrelated.pdf', mimeType: 'application/pdf', scope: 'drawing', metadata: { projectId: createdId, drawingNo: 'NOT-LINKED' }, contentBase64: drawingV1 }) });
    assert(unrelatedDrawing.status === 404, 'drawing upload cannot attach a file to an Enquiry item that does not exist');
    const drawingSaved2 = await uploadDrawing(drawingV2);
    assert(drawingSaved2.status === 200 && drawingSaved2.body.file.checksumSha256 !== drawingSaved1.body.file.checksumSha256, 'drawing update returns a new integrity checksum');
    const legacyOverwrite = await api(`/api/files/${encodeURIComponent(fileId)}`, tokenA, { method: 'PUT', body: JSON.stringify({ fileName: 'legacy.pdf', mimeType: 'application/pdf', scope: 'drawing', metadata: { projectId: createdId, drawingNo: 'TEST-001' }, contentBase64: drawingV1, ifAbsent: true }) });
    assert(legacyOverwrite.status === 409, 'legacy attachment migration is create-only and cannot overwrite a server copy');
    const drawingFetch = await api(`/api/files/${encodeURIComponent(fileId)}`, tokenB);
    assert(drawingFetch.status === 200 && drawingFetch.body.mimeType === 'application/pdf' && Buffer.compare(Buffer.from(drawingFetch.body.contentBase64, 'base64'), drawingBytesV2) === 0, 'second client reads byte-identical PDF content from PostgreSQL');

    const edited = {...linkedData, engineeringNotes: 'Saved by client A' };
    const update = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenA, { method: 'PUT', body: JSON.stringify({ data: edited, version: linkedEnquiry.body.record.version }) });
    assert(update.status === 200 && update.body.record.version === linkedEnquiry.body.record.version + 1, 'edit persists and increments the version');
    const stale = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenB, { method: 'PUT', body: JSON.stringify({ data: {...linkedData, engineeringNotes: 'Stale client B' }, version: linkedEnquiry.body.record.version }) });
    assert(stale.status === 409 && stale.body.current?.engineeringNotes === 'Saved by client A', 'concurrent stale edit is rejected with the current server copy');

    referenceRecordId = `${createdId}-reference`;
    await testPool.query(
        'INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES($1,$2,$3::jsonb,1,now(),$4)',
        ['__enquiry_test_reference', referenceRecordId, JSON.stringify({ projectId: createdId }), 'enquiry-test']
    );
    const protectedDelete = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenA, { method: 'DELETE', body: JSON.stringify({ version: update.body.record.version, reason: 'Referenced record protection test' }) });
    const stillPresent = await testPool.query("SELECT 1 FROM module_records WHERE storage_key='projectRequests' AND record_id=$1", [createdId]);
    assert(protectedDelete.status === 409 && stillPresent.rowCount === 1, 'delete is blocked while another record references the enquiry');
    await testPool.query('DELETE FROM module_records WHERE storage_key=$1 AND record_id=$2', ['__enquiry_test_reference', referenceRecordId]);
    referenceRecordId = '';

    await stopServer();
    await startServer();
    tokenA = await login();
    tokenB = await login();
    const afterRestart = await api('/api/enquiries', tokenA);
    const persisted = afterRestart.body.records.find((record) => record.projectId === createdId);
    assert(Boolean(persisted) && persisted.engineeringNotes === 'Saved by client A', 'confirmed edit survives Express restart and new login');

    const removed = await api(`/api/enquiries/${encodeURIComponent(createdId)}`, tokenA, { method: 'DELETE', body: JSON.stringify({ version: persisted.version, reason: 'Isolated automated test cleanup' }) });
    assert(removed.status === 200 && removed.body.success, 'Admin delete is confirmed by PostgreSQL');
    const gone = await testPool.query("SELECT 1 FROM module_records WHERE storage_key='projectRequests' AND record_id=$1", [createdId]);
    assert(gone.rowCount === 0, 'deleted enquiry is absent from PostgreSQL');
    const tombstone = await testPool.query('SELECT record_id,deleted_by,deleted_by_email,reason,audit_id,create_token FROM enquiry_tombstones WHERE record_id=$1', [createdId]);
    assert(tombstone.rowCount === 1 && tombstone.rows[0].audit_id && tombstone.rows[0].create_token === createToken, 'delete creates durable tombstone with actor, reason, audit link, and create token');
    const audit = await testPool.query("SELECT 1 FROM erp_audit_log WHERE module='projectRequests' AND record_id=$1 AND action='DELETE'", [createdId]);
    assert(audit.rowCount > 0, 'delete audit entry is preserved');
    const auditHistory = await testPool.query("SELECT action FROM erp_audit_log WHERE module='projectRequests' AND record_id=$1 ORDER BY id", [createdId]);
    assert(['CREATE','UPDATE','DELETE'].every((action) => auditHistory.rows.some((entry) => entry.action === action)), 'create/update/delete audit history remains intact');
    const blockedImport = await api('/api/enquiries/migration-preview/import-missing', tokenA, { method: 'POST', body: JSON.stringify({ records: [{ ...data, projectId: createdId }] }) });
    assert(blockedImport.status === 200 && blockedImport.body.deleted.includes(createdId) && blockedImport.body.imported.length === 0, 'legacy import cannot recreate a tombstoned Enquiry ID');
    const blockedRetry = await api('/api/enquiries', tokenA, { method: 'POST', body: JSON.stringify({ data, createToken, sequenceHint: 0 }) });
    assert(blockedRetry.status === 409, 'normal create retry cannot reuse the deleted Enquiry create token');
    const migrationPreview = await api('/api/enquiries/migration-preview', tokenA);
    assert(migrationPreview.body.deleted.some((entry) => entry.record_id === createdId) && !migrationPreview.body.eligible.some((entry) => entry.projectId === createdId), 'migration preview distinctly reports tombstoned legacy data as blocked');
    const serverDrawingAfterRestart = await api(`/api/files/${encodeURIComponent(fileId)}`, tokenB);
    assert(serverDrawingAfterRestart.status === 200 && Buffer.compare(Buffer.from(serverDrawingAfterRestart.body.contentBase64, 'base64'), drawingBytesV2) === 0, 'latest PDF persists after Express restart and is readable by a second client session');
    const deletedFile = await api(`/api/files/${encodeURIComponent(fileId)}`, tokenA, { method: 'DELETE', body: JSON.stringify({ reason: 'Isolated automated test attachment cleanup' }) });
    assert(deletedFile.status === 200, 'isolated test drawing fixture is removed through its Admin API');
    const importedDelete = await api(`/api/enquiries/${encodeURIComponent(importedId)}`, tokenA, { method: 'DELETE', body: JSON.stringify({ version: 1, reason: 'Isolated automated test cleanup' }) });
    assert(importedDelete.status === 200, 'imported fixture is cleaned up through Admin API');
    const checksumFixtureDelete = await api(`/api/files/${encodeURIComponent(missingChecksumId)}`, tokenA, { method: 'DELETE', body: JSON.stringify({ reason: 'Isolated automated checksum fixture cleanup' }) });
    assert(checksumFixtureDelete.status === 200, 'isolated checksum review attachment fixture is cleaned up through Admin API');
    await testPool.query("DELETE FROM module_records WHERE storage_key='projectRequests' AND record_id=$1", [checksumFixtureProjectId]);
    if (restrictedSessionHash) await testPool.query('DELETE FROM erp_sessions WHERE token_hash=$1', [restrictedSessionHash]);
    if (restrictedEmployeeId) await testPool.query('DELETE FROM employees WHERE id=$1', [restrictedEmployeeId]);
    if (authorizedSessionHash) await testPool.query('DELETE FROM erp_sessions WHERE token_hash=$1', [authorizedSessionHash]);
    if (authorizedEmployeeId) await testPool.query('DELETE FROM employees WHERE id=$1', [authorizedEmployeeId]);
    if (orphanFileId) await testPool.query('DELETE FROM file_blobs WHERE id=$1', [orphanFileId]);
    console.log(`Enquiry PostgreSQL integration checks passed: ${passedCount} passed, 0 failed, 0 skipped.`);
} catch (error) {
    console.error(`Enquiry PostgreSQL integration checks failed: ${passedCount} passed; at least 1 failed. ${error.message}`);
    if (tokenA) {
        try {
            const list = await api('/api/enquiries', tokenA);
            for (const id of [createdId, importedId].filter(Boolean)) {
                const record = list.body.records?.find((entry) => entry.projectId === id);
                if (record) await api(`/api/enquiries/${encodeURIComponent(id)}`, tokenA, { method: 'DELETE', body: JSON.stringify({ version: record.version, reason: 'Isolated test failure cleanup' }) });
            }
        } catch { /* preserve the original failure */ }
    }
    if (referenceRecordId) {
        try { await testPool.query('DELETE FROM module_records WHERE storage_key=$1 AND record_id=$2', ['__enquiry_test_reference', referenceRecordId]); } catch { /* preserve original failure */ }
    }
    if (missingChecksumId) {
        try { await testPool.query('DELETE FROM file_blobs WHERE id=$1', [missingChecksumId]); } catch { /* preserve original failure */ }
    }
    if (checksumFixtureProjectId) {
        try { await testPool.query("DELETE FROM module_records WHERE storage_key='projectRequests' AND record_id=$1", [checksumFixtureProjectId]); } catch { /* preserve original failure */ }
    }
    if (createdId) {
        try { await testPool.query('DELETE FROM file_blobs WHERE id=$1', [`drawing::${encodeURIComponent(createdId)}::${encodeURIComponent('TEST-001')}`]); } catch { /* preserve original failure */ }
    }
    if (restrictedSessionHash) {
        try { await testPool.query('DELETE FROM erp_sessions WHERE token_hash=$1', [restrictedSessionHash]); } catch { /* preserve original failure */ }
    }
    if (restrictedEmployeeId) {
        try { await testPool.query('DELETE FROM employees WHERE id=$1', [restrictedEmployeeId]); } catch { /* preserve original failure */ }
    }
    if (authorizedSessionHash) {
        try { await testPool.query('DELETE FROM erp_sessions WHERE token_hash=$1', [authorizedSessionHash]); } catch { /* preserve original failure */ }
    }
    if (authorizedEmployeeId) {
        try { await testPool.query('DELETE FROM employees WHERE id=$1', [authorizedEmployeeId]); } catch { /* preserve original failure */ }
    }
    if (orphanFileId) {
        try { await testPool.query('DELETE FROM file_blobs WHERE id=$1', [orphanFileId]); } catch { /* preserve original failure */ }
    }
    throw error;
} finally {
    await stopServer();
    await testPool.end();
}
