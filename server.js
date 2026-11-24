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
import { checkDatabase, closeDatabase, runMigrations, getMigrationStatus } from './server/database.js';
import { startQualityPullSync } from './server/qualityPullSync.js';
import { validateEmail } from './shared/fieldValidation.js';
import { authRouter, authenticateRequest, requireDepartmentPermission } from './server/auth.js';

const __filename = fileURLToPath(
    import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
// Base64 file payloads inflate ~33%; the limit must fit MAX_FILE_BYTES (50 MB)
// uploads for /api/files alongside the existing ERP state records.
app.use(express.json({ limit: '120mb' }));
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
    let database = { configured: Boolean(process.env.DATABASE_URL), connected: false };
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
        version: '1.1.0'
    });
});

// All ERP data routes require a server issued identity. UI role checks are
// only for presentation; sensitive mutations also use requireAdmin at routes.
app.use('/api', authenticateRequest);
app.use('/api/ballooning', requireDepartmentPermission('ballooning.view', 'ballooning.manage'), ballooningRouter);
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
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
});

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, HOST, async() => {
    console.log(`VYAVASTA ERP running on http://${HOST}:${PORT}`);
    console.log(`Local access: http://localhost:${PORT}`);
    console.log(`SMTP configured: ${Boolean(process.env.SMTP_HOST)}`);
    if (process.env.DATABASE_URL) {
        try {
            await runMigrations();
            console.log('PostgreSQL migrations are up to date.');
            // Two-way sync with the mobile QC server: periodically pull
            // checks/measurements/dispatches recorded on phones into the
            // ERP Quality Module. Disable with QC_PULL_ENABLED=0.
            if (process.env.QC_PULL_ENABLED !== '0') startQualityPullSync();
        } catch (error) {
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
