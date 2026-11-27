import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import ballooningRouter from './server/ballooningRoutes.js';
import erpStateRouter from './server/erpStateRoutes.js';
import fileRouter from './server/fileRoutes.js';
import moduleRecordsRouter from './server/moduleRecordsRoutes.js';
import customerPurchaseOrderRouter from './server/customerPurchaseOrderRoutes.js';
import qualityRouter from './server/qualityRoutes.js';
import tallyExportRouter from './server/tallyExportRoutes.js';
import enquiryRouter from './server/enquiryRoutes.js';
import quotationRouter from './server/quotationRoutes.js';
import salesOrderRouter from './server/salesOrderRoutes.js';
import deliveryChallanRouter from './server/deliveryChallanRoutes.js';
import customerInvoiceRouter from './server/customerInvoiceRoutes.js';
import exportInvoiceRouter from './server/exportInvoiceRoutes.js';
import procurementIntakeRouter from './server/procurementIntakeRoutes.js';
import materialReceiptRouter from './server/materialReceiptRoutes.js';
import storeRouter from './server/storeRoutes.js';
import inventoryRouter from './server/inventoryRoutes.js';
import masterRouter from './server/masterRoutes.js';
import debitNoteRouter from './server/debitNoteRoutes.js';
import commercialReturnsRouter from './server/commercialReturnRoutes.js';
import databaseBackupRouter from './server/databaseBackupRoutes.js';
import bomRouter from './server/bomRoutes.js';
import productionRouter from './server/productionRoutes.js';
import routingRouter from './server/routingRoutes.js';
import recycleBinRouter from './server/recycleBinRoutes.js';
import purchaseRequestRouter from './server/purchaseRequestRoutes.js';
import advanceRouter from './server/advanceRoutes.js';
import availabilityCheckRouter from './server/availabilityCheckRoutes.js';
import employeeRouter from './server/employeeRoutes.js';
import departmentRoleCatalogRouter from './server/departmentRoleCatalogRoutes.js';
import { checkDatabase, closeDatabase, runMigrations, getMigrationStatus, hasDatabaseConfiguration } from './server/database.js';
import { startQualityPullSync } from './server/qualityPullSync.js';
import { validateEmail } from './shared/fieldValidation.js';
import { authRouter, authenticateRequest, requireDepartmentPermission } from './server/auth.js';

const __filename = fileURLToPath(
    import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
let databaseReady = !hasDatabaseConfiguration();
// Base64 file payloads inflate ~33%; the limit must fit MAX_FILE_BYTES (50 MB)
// uploads for /api/files alongside the existing ERP state records.
app.use(express.json({ limit: '120mb' }));
app.use('/api', (req, res, next) => {
    if (req.path === '/health' || databaseReady) return next();
    return res.status(503).json({ error: 'ERP database migrations are not ready yet. Retry shortly.' });
});
app.use('/api/auth', authRouter);

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
        throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env or environment.');
    }
    transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });
    return transporter;
}

app.post('/api/send-quotation-email', authenticateRequest, requireDepartmentPermission('sales.quotation'), async(req, res) => {
    try {
        const { to, cc, bcc, subject, htmlBody, pdfBase64, fileName, attachments } = req.body;
        if (!to) return res.status(400).json({ success: false, error: 'Recipient email (to) is required.' });
        for (const [label, address] of [['to', to], ['cc', cc], ['bcc', bcc]]) {
            if (!address) continue;
            const recipients = String(address).split(',').map((entry) => entry.trim()).filter(Boolean);
            if (recipients.some((email) => validateEmail(email))) {
                return res.status(400).json({ success: false, error: 'Please enter a valid email address.', field: label });
            }
        }

        // Accepts the multi-attachment array (ballooning share), and still honours
        // the legacy single pdfBase64 field the quotation email modal sends.
        const requested =
            Array.isArray(attachments) && attachments.length ?
            attachments :
            pdfBase64 ?
            [{
                fileName: fileName || 'Quotation.pdf',
                contentType: 'application/pdf',
                contentBase64: pdfBase64
            }] :
            [];

        if (requested.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one attachment is required.' });
        }

        const transport = getTransporter();

        const mailOptions = {
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to,
            cc: cc || undefined,
            bcc: bcc || undefined,
            subject: subject || 'Quotation',
            html: htmlBody || '',
            attachments: requested.map((item) => ({
                filename: item.fileName || 'attachment',
                content: Buffer.from(item.contentBase64 || '', 'base64'),
                contentType: item.contentType || 'application/octet-stream'
            }))
        };

        const info = await transport.sendMail(mailOptions);
        res.json({
            success: true,
            message: `Email sent successfully with ${requested.length} attachment(s).`,
            messageId: info.messageId
        });
    } catch (err) {
        console.error('Email send error:', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to send email.' });
    }
});

app.get('/api/health', async (_req, res) => {
    let database = { configured: hasDatabaseConfiguration(), connected: false };
    if (database.configured) {
        try {
            database.connected = await checkDatabase();
            database.migrations = await getMigrationStatus();
        } catch (error) {
            database.error = error.message || 'Database unavailable';
        }
    }
    const degraded = database.configured && !database.connected;
    res.status(degraded ? 503 : 200).json({
        status: degraded ? 'degraded' : 'ok',
        smtp: Boolean(process.env.SMTP_HOST),
        database,
        ready: databaseReady && (!database.configured || database.connected),
        version: '1.1.0'
    });
});

// All ERP data routes require a server issued identity. UI role checks are
// only for presentation; sensitive mutations also use requireAdmin at routes.
app.use('/api', authenticateRequest);
app.use('/api/employees', employeeRouter);
app.use('/api/organization-catalogs', departmentRoleCatalogRouter);
app.use('/api/ballooning', requireDepartmentPermission('ballooning.view', 'ballooning.manage'), ballooningRouter);
app.use('/api/enquiries', enquiryRouter);
app.use('/api/quotations', requireDepartmentPermission('sales.quotation'), quotationRouter);
app.use('/api/sales-orders', requireDepartmentPermission('sales_order.view'), salesOrderRouter);
app.use('/api/delivery-challans', requireDepartmentPermission('delivery.view', 'delivery.create'), deliveryChallanRouter);
app.use('/api/customer-invoices', requireDepartmentPermission('invoice.view'), customerInvoiceRouter);
app.use('/api/export-invoices', requireDepartmentPermission('invoice.view'), exportInvoiceRouter);
app.use('/api/procurement', procurementIntakeRouter);
app.use('/api/store', storeRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/masters', masterRouter);
app.use('/api/debit-notes', debitNoteRouter);
app.use('/api/commercial-returns', commercialReturnsRouter);
app.use('/api/database-backups', databaseBackupRouter);
app.use('/api/bom', bomRouter);
app.use('/api/production', productionRouter);
app.use('/api/routing', routingRouter);
app.use('/api/recycle-bin', recycleBinRouter);
app.use('/api/purchase-requests', purchaseRequestRouter);
app.use('/api/advances', advanceRouter);
app.use('/api/availability-checks', availabilityCheckRouter);
app.use('/api', materialReceiptRouter);
app.use('/api', erpStateRouter);
app.use('/api/files', fileRouter);
app.use('/api/records', moduleRecordsRouter);
app.use('/api/customer-purchase-orders', requireDepartmentPermission('sales.customer_order'), customerPurchaseOrderRouter);
app.use('/api/quality', requireDepartmentPermission('production.qc.view', 'production.qc.manage'), qualityRouter);
app.use('/api', requireDepartmentPermission('tally.export'), tallyExportRouter);

// Catch unhandled /api calls and return a clean JSON error (never HTML)
app.use('/api', (req, res) => {
    res.status(404).json({ error: `API endpoint '${req.method} ${req.originalUrl}' not found` });
});

// Serve production React bundle from dist directory
const distDir = join(__dirname, 'dist');
app.use(express.static(distDir));

// Missing static files must not fall through to the SPA document. Browsers
// require JavaScript and CSS module assets to be served with their real MIME
// types, and an HTML fallback for a missing bundle produces a blank screen.
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = req.path || '';
    const isAssetRequest = pathname.startsWith('/assets/') || /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot)$/i.test(pathname);
    if (isAssetRequest) return res.status(404).type('text/plain').send('Asset not found');
    next();
});

// React SPA client-side routing fallback for non-API GET requests
app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.originalUrl.startsWith('/api')) {
        const indexPath = join(distDir, 'index.html');
        if (existsSync(indexPath)) {
            return res.sendFile(indexPath);
        }
        return res.status(503).send('React production build not found. Run "npm run build" first.');
    }
    next();
});

app.use((error, _req, res, _next) => {
    const status = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
    if (status >= 500) console.error('API error:', error.message);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message, ...(error.current ? { current: error.current } : {}) });
});

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, HOST, async() => {
    console.log(`VYAVASTA ERP running on http://${HOST}:${PORT}`);
    console.log(`Local access: http://localhost:${PORT}`);
    console.log(`SMTP configured: ${Boolean(process.env.SMTP_HOST)}`);
    if (hasDatabaseConfiguration()) {
        try {
            await runMigrations();
            databaseReady = true;
            console.log('PostgreSQL migrations are up to date.');
            // Two-way sync with the mobile QC server: periodically pull
            // checks/measurements/dispatches recorded on phones into the
            // ERP Quality Module. Disable with QC_PULL_ENABLED=0.
            if (process.env.QC_PULL_ENABLED !== '0') startQualityPullSync();
        } catch (error) {
            databaseReady = false;
            console.error('PostgreSQL migration startup check failed:', error.message);
        }
    } else {
        console.log('PostgreSQL disabled: DATABASE_URL is not configured.');
    }
});

const shutdown = async(signal) => {
    console.log(`${signal} received; shutting down.`);
    server.close(async() => {
        await closeDatabase();
        process.exit(0);
    });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
