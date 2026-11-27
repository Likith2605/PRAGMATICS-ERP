import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { getFinancialYearInfo } from '../src/utils/financialYear.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const validate = (payload) => {
  const details = payload?.invoiceDetails || {}; const number = String(details.invoiceNumber || '').trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(number)) throw bad('A valid Customer Invoice number is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(details.invoiceDate || ''))) throw bad('Invoice date must use YYYY-MM-DD format.');
  if (!String(payload?.billTo?.name || payload?.customerDetails?.customerName || payload?.customerDetails?.companyName || '').trim()) throw bad('Customer name is required.');
  if (!Array.isArray(payload?.items) || !payload.items.length) throw bad('At least one invoice line is required.');
  if (Buffer.byteLength(JSON.stringify(payload)) > 8 * 1024 * 1024) throw Object.assign(new Error('Invoice exceeds the record size limit.'), { status: 413 });
  return number;
};
const columns = (payload) => {
  const details = payload.invoiceDetails || {}; const customer = payload.customerDetails || {};
  const name = payload.billTo?.name || customer.companyName || customer.customerName;
  return [details.invoiceDate, details.dueDate || null, name, details.quotationRef || '', details.salesOrderRef || '', details.dcRef || '', details.projectId || '', details.paymentStatus || 'Pending', payload.currency || details.currency || 'INR', numeric(payload.totals?.grandTotal), numeric(details.amountReceived), numeric(details.balanceDue), numeric(payload.amountINR), numeric(payload.receivedINR), numeric(payload.balanceINR)];
};
const settledPayload = (payload, advanceAdjusted = 0, advanceAdjustedINR = 0) => {
  const details = payload.invoiceDetails || {};
  const total = numeric(payload.totals?.grandTotal);
  const received = numeric(details.amountReceived);
  if (received < 0) throw bad('Received amount cannot be negative.');
  if (received + advanceAdjusted > total + 0.00005) throw bad('Payments and advance allocations cannot exceed the invoice total.');
  const balanceDue = Math.max(0, total - received - advanceAdjusted);
  const totalINR = numeric(payload.amountINR || total);
  const receivedINR = numeric(payload.receivedINR || received);
  const balanceINR = Math.max(0, totalINR - receivedINR - advanceAdjustedINR);
  const paymentStatus = balanceDue <= 0.00005 ? 'Paid' : received + advanceAdjusted > 0 ? 'Partial' : 'Pending';
  return {
    ...payload,
    invoiceDetails: { ...details, amountReceived: received, advanceAdjusted, advanceAdjustedINR, balanceDue, paymentStatus },
    advanceAdjustedINR,
    balanceINR
  };
};
const invoiceBalance = (row) => {
  const total = numeric(row.grand_total);
  const received = numeric(row.amount_received);
  const advanceAdjusted = numeric(row.advance_adjusted);
  const balanceDue = Math.max(0, total - received - advanceAdjusted);
  const totalINR = numeric(row.amount_inr || total);
  const receivedINR = numeric(row.received_inr || received);
  const balanceINR = Math.max(0, totalINR - receivedINR - numeric(row.advance_adjusted_inr));
  const paymentStatus = balanceDue <= 0.00005 ? 'Paid' : received + advanceAdjusted > 0 ? 'Partial' : 'Pending';
  const payload = {
    ...row.payload,
    invoiceDetails: {
      ...row.payload?.invoiceDetails,
      amountReceived: received,
      advanceAdjusted,
      advanceAdjustedINR: numeric(row.advance_adjusted_inr),
      balanceDue,
      paymentStatus
    },
    advanceAdjustedINR: numeric(row.advance_adjusted_inr),
    balanceINR
  };
  return { balanceDue, balanceINR, paymentStatus, payload };
};
const view = (row) => {
  const currency = row.currency;
  const settlement = invoiceBalance(row);
  return { date: String(row.invoice_date).slice(0,10), reference: row.invoice_number, quotationRef: row.quotation_ref || '-', company: row.customer_name, total: currency === 'INR' ? numeric(row.grand_total).toLocaleString('en-IN',{maximumFractionDigits:2}) : `${currency} ${numeric(row.grand_total).toFixed(2)}`, amountReceived: currency === 'INR' ? numeric(row.amount_received).toLocaleString('en-IN',{maximumFractionDigits:2}) : `${currency} ${numeric(row.amount_received).toFixed(2)}`, advanceAdjusted: numeric(row.advance_adjusted), advanceAdjustedINR: numeric(row.advance_adjusted_inr), balanceDue: currency === 'INR' ? settlement.balanceDue.toLocaleString('en-IN',{maximumFractionDigits:2}) : `${currency} ${settlement.balanceDue.toFixed(2)}`, amountINR: numeric(row.amount_inr), receivedINR: numeric(row.received_inr), balanceINR: settlement.balanceINR, currency, status: settlement.paymentStatus, version: Number(row.version), payload: settlement.payload };
};
const audit = (client, req, number, action, before, after, reason = '') => client.query(
  `INSERT INTO customer_invoice_audit(invoice_number,user_id,email,role,action,reason,before_values,after_values) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [number,req.user.id,req.user.email,req.user.role,action,reason,before == null ? null : JSON.stringify(safeAuditValues(before)),after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const items = async (client, number, rows) => {
  for (const [index,item] of rows.entries()) await client.query('INSERT INTO customer_invoice_items(invoice_number,line_number,item_name,quantity,unit_price,line_amount,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [number,index+1,String(item?.itemName||''),numeric(item?.quantity),numeric(item?.unitPrice),numeric(item?.amount),JSON.stringify(item)]);
};
const insert = async (client, req, payload, token = null, action = 'CREATE') => {
  const number = validate(payload); const savedPayload = settledPayload(payload); const vals = columns(savedPayload);
  const result = await client.query(`INSERT INTO customer_invoices(invoice_number,invoice_date,due_date,customer_name,quotation_ref,sales_order_ref,delivery_challan_ref,project_id,payment_status,currency,grand_total,amount_received,balance_due,amount_inr,received_inr,balance_inr,payload,create_token,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$19) RETURNING *`, [number,...vals,JSON.stringify(savedPayload),token,req.user.email]);
  await items(client,number,savedPayload.items); await audit(client,req,number,action,null,savedPayload,action==='IMPORT'?'Admin-confirmed legacy Customer Invoice migration':''); return result.rows[0];
};

router.get('/', async (_req,res) => { const r=await getPool().query('SELECT * FROM customer_invoices WHERE deleted_at IS NULL ORDER BY invoice_date DESC,invoice_number DESC'); res.json({records:r.rows.map(view)}); });
router.post('/next-number', async (req,res) => {
  const date=String(req.body?.date||new Date().toISOString().slice(0,10));if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw bad('Invoice sequence date must use YYYY-MM-DD format.');
  const c=await getPool().connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('customer-invoice-sequence'))");
    const [stored,history,maximum]=await Promise.all([
      c.query('SELECT last_number FROM customer_invoice_sequences WHERE sequence_id=1 FOR UPDATE'),
      c.query("SELECT storage_key,data FROM erp_state WHERE storage_key=ANY($1::text[])",[['customerInvoiceHistory','customerInvoiceSequence']]),
      c.query("SELECT COALESCE(max((regexp_match(invoice_number,'([0-9]+)$'))[1]::bigint),0) AS n FROM customer_invoices")
    ]);
    let max=Number(stored.rows[0]?.last_number||0);max=Math.max(max,Number(maximum.rows[0]?.n||0));
    for(const row of history.rows){if(row.storage_key==='customerInvoiceSequence')max=Math.max(max,Number(row.data)||0);else if(Array.isArray(row.data))for(const entry of row.data){const match=String(entry?.reference||entry?.payload?.invoiceDetails?.invoiceNumber||'').match(/(\d+)$/);if(match)max=Math.max(max,Number(match[1])||0);}}
    const next=max+1;await c.query('INSERT INTO customer_invoice_sequences(sequence_id,last_number,updated_at) VALUES(1,$1,now()) ON CONFLICT(sequence_id) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()',[next]);await c.query('COMMIT');
    res.json({invoiceNumber:`INV-${getFinancialYearInfo(date).fyCompact}-${String(next).padStart(4,'0')}`});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
});
router.get('/migration-preview', requireAdmin, async (_req,res) => {
  const [legacy,current]=await Promise.all([getPool().query("SELECT data FROM erp_state WHERE storage_key='customerInvoiceHistory'"),getPool().query('SELECT invoice_number,payload,deleted_at FROM customer_invoices')]);
  const old=Array.isArray(legacy.rows[0]?.data)?legacy.rows[0].data:[]; const byId=new Map(current.rows.map(r=>[r.invoice_number.toLowerCase(),r])); const eligible=[],existing=[],conflicts=[],deleted=[],seen=new Set();
  for(const entry of old){const payload=entry?.payload;const number=String(payload?.invoiceDetails?.invoiceNumber||entry?.reference||'').trim();if(!number||seen.has(number.toLowerCase())){if(number)conflicts.push({number,reason:'Duplicate legacy ID'});continue;}seen.add(number.toLowerCase());const row=byId.get(number.toLowerCase());if(row?.deleted_at)deleted.push({number});else if(row){(JSON.stringify(row.payload)===JSON.stringify(payload)?existing:conflicts).push({number,reason:'Existing PostgreSQL record differs'});}else{try{validate(payload);eligible.push({number,payload});}catch(e){conflicts.push({number,reason:e.message});}}}
  res.json({eligible,existing,conflicts,deleted,counts:{eligible:eligible.length,existing:existing.length,conflicts:conflicts.length,deleted:deleted.length}});
});
router.post('/migration-preview/import-missing',requireAdmin,async(req,res)=>{
  const records=Array.isArray(req.body?.records)?req.body.records:[];if(!records.length||records.length>1000)throw bad('Select between 1 and 1000 Customer Invoices to import.');
  const client=await getPool().connect();try{await client.query('BEGIN');const imported=[],conflicts=[];for(const payload of records){const number=validate(payload);await client.query("SELECT pg_advisory_xact_lock(hashtext('customer-invoice:'||$1))",[number]);const found=await client.query('SELECT deleted_at FROM customer_invoices WHERE invoice_number=$1 FOR UPDATE',[number]);if(found.rowCount){conflicts.push({number,reason:found.rows[0].deleted_at?'Deleted ID is protected':'Record already exists'});continue;}await insert(client,req,payload,null,'IMPORT');imported.push(number);}await client.query('COMMIT');res.json({imported,conflicts});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
router.get('/:number',async(req,res)=>{const r=await getPool().query('SELECT * FROM customer_invoices WHERE invoice_number=$1 AND deleted_at IS NULL',[req.params.number]);if(!r.rowCount)return res.status(404).json({error:'Customer Invoice not found.'});res.json({record:view(r.rows[0])});});
router.post('/',async(req,res)=>{const payload=req.body?.data;const number=validate(payload);const token=String(req.body?.createToken||'');if(!/^[A-Za-z0-9._:-]{8,120}$/.test(token))throw bad('A valid idempotency token is required.');const c=await getPool().connect();try{await c.query('BEGIN');const prior=await c.query('SELECT * FROM customer_invoices WHERE create_token=$1 FOR UPDATE',[token]);if(prior.rowCount){if(prior.rows[0].deleted_at)throw conflict('Deleted invoice cannot be restored by retry.');await c.query('COMMIT');return res.json({record:view(prior.rows[0]),duplicate:true});}await c.query("SELECT pg_advisory_xact_lock(hashtext('customer-invoice:'||$1))",[number]);const exists=await c.query('SELECT deleted_at FROM customer_invoices WHERE invoice_number=$1 FOR UPDATE',[number]);if(exists.rowCount)throw conflict('Invoice number already exists or is protected by deletion.');const row=await insert(c,req,payload,token);await c.query('COMMIT');res.status(201).json({record:view(row),duplicate:false});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
router.put('/:number',async(req,res)=>{const number=String(req.params.number);const payload=req.body?.data;if(validate(payload)!==number)throw bad('Invoice number cannot change during edit.');const version=Number(req.body?.version);if(!Number.isInteger(version)||version<1)throw bad('The PostgreSQL version last read is required.');const c=await getPool().connect();try{await c.query('BEGIN');const current=await c.query('SELECT * FROM customer_invoices WHERE invoice_number=$1 AND deleted_at IS NULL FOR UPDATE',[number]);if(!current.rowCount)throw Object.assign(new Error('Customer Invoice not found.'),{status:404});if(Number(current.rows[0].version)!==version)throw conflict('Invoice changed on the server. Reload before editing.',view(current.rows[0]));const allocations=await c.query('SELECT 1 FROM customer_advance_adjustments WHERE invoice_number=$1 AND voided_at IS NULL LIMIT 1',[number]);const submitted=columns(payload);if(allocations.rowCount&&(String(submitted[2]).trim().toLowerCase()!==String(current.rows[0].customer_name).trim().toLowerCase()||String(submitted[8]).toUpperCase()!==String(current.rows[0].currency).toUpperCase()))throw conflict('Customer and currency cannot change while an advance is applied to this invoice.');const savedPayload=settledPayload(payload,numeric(current.rows[0].advance_adjusted),numeric(current.rows[0].advance_adjusted_inr));const v=columns(savedPayload);const r=await c.query('UPDATE customer_invoices SET invoice_date=$2,due_date=$3,customer_name=$4,quotation_ref=$5,sales_order_ref=$6,delivery_challan_ref=$7,project_id=$8,payment_status=$9,currency=$10,grand_total=$11,amount_received=$12,balance_due=$13,amount_inr=$14,received_inr=$15,balance_inr=$16,payload=$17::jsonb,version=version+1,updated_at=now(),updated_by=$18 WHERE invoice_number=$1 RETURNING *',[number,...v,JSON.stringify(savedPayload),req.user.email]);await c.query('DELETE FROM customer_invoice_items WHERE invoice_number=$1',[number]);await items(c,number,savedPayload.items);await audit(c,req,number,'UPDATE',current.rows[0].payload,savedPayload);await c.query('COMMIT');res.json({record:view(r.rows[0])});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
router.delete('/:number',requireAdmin,async(req,res)=>{const number=String(req.params.number);const version=Number(req.body?.version);if(!Number.isInteger(version)||version<1)throw bad('The PostgreSQL version last read is required.');const c=await getPool().connect();try{await c.query('BEGIN');const r=await c.query('SELECT * FROM customer_invoices WHERE invoice_number=$1 AND deleted_at IS NULL FOR UPDATE',[number]);if(!r.rowCount)throw Object.assign(new Error('Customer Invoice not found.'),{status:404});if(Number(r.rows[0].version)!==version)throw conflict('Invoice changed on the server. Reload before deleting.');const allocation=await c.query('SELECT 1 FROM customer_advance_adjustments WHERE invoice_number=$1 AND voided_at IS NULL LIMIT 1',[number]);if(allocation.rowCount)throw conflict('Reverse active advance adjustments before deleting this invoice.');const reason=String(req.body?.reason||'').trim();await c.query('UPDATE customer_invoices SET deleted_at=now(),deleted_by=$2,delete_reason=$3,updated_at=now(),updated_by=$2,version=version+1 WHERE invoice_number=$1',[number,req.user.email,reason]);await audit(c,req,number,'SOFT_DELETE',r.rows[0].payload,null,reason);await c.query('COMMIT');res.json({deleted:number});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
export default router;
