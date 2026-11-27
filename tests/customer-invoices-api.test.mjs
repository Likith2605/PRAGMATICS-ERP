/** Guarded PostgreSQL integration test for Customer Invoices. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl=process.env.ERP_TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if(decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//,''))!=='vyavastha_test')throw new Error('Refusing Customer Invoice tests outside vyavastha_test.');
if(!process.env.ERP_ADMIN_EMAIL||!process.env.ERP_ADMIN_PASSWORD)throw new Error('ERP Admin test credentials are required.');
const pool=new pg.Pool({connectionString:databaseUrl});
const identity=await pool.query('SELECT current_database() AS name');
if(identity.rows[0]?.name!=='vyavastha_test'){await pool.end();throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');}
const port=Number(process.env.ERP_CUSTOMER_INVOICE_TEST_PORT||3384),base=`http://127.0.0.1:${port}`;let child,token='',assertions=0;
const assert=(condition,label)=>{if(!condition)throw new Error(label);assertions++;console.log(`PASS ${label}`);};
const api=async(path,options={})=>{const r=await fetch(`${base}${path}`,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`,'X-ERP-Department':'Admin'}:{}),...(options.headers||{})}});return{status:r.status,body:await r.json().catch(()=>({}))};};
const start=async()=>{const env={...process.env,ERP_TEST_MODE:'1',ERP_TEST_DATABASE_URL:databaseUrl,PORT:String(port)};delete env.DATABASE_URL;child=spawn(process.execPath,['server.js'],{env,stdio:'ignore'});for(let i=0;i<100;i++){try{const h=await(await fetch(`${base}/api/health`)).json();if(h.ready&&h.database?.migrations?.some((m)=>m.version==='021_customer_invoice_sequence'))return;}catch{}await new Promise((r)=>setTimeout(r,200));}throw new Error('Isolated Customer Invoice server did not become ready.');};
const stop=async()=>{if(!child)return;child.kill();await new Promise((r)=>child.once('exit',r));child=null;};
try{
  await start();const login=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:process.env.ERP_ADMIN_EMAIL,password:process.env.ERP_ADMIN_PASSWORD,portal:'admin'})});token=login.body.token;assert(login.status===200&&token,'Admin authentication succeeds');
  const reserved=await Promise.all([1,2].map(()=>api('/api/customer-invoices/next-number',{method:'POST',body:JSON.stringify({date:new Date().toISOString().slice(0,10)})})));assert(reserved.every(r=>/^INV-\d{4}-\d{4,}$/.test(r.body.invoiceNumber))&&reserved[0].body.invoiceNumber!==reserved[1].body.invoiceNumber,'Concurrent invoice number reservations are unique and preserve the INV-FY-#### format');
  const number=`CIT-${Date.now()}`,date=new Date().toISOString().slice(0,10);
  const payload={invoiceDetails:{invoiceNumber:number,invoiceDate:date,dueDate:date,quotationRef:'QT-TEST',salesOrderRef:'SO-TEST',dcRef:'DC-TEST',projectId:'CITEST',paymentStatus:'Pending',amountReceived:0,balanceDue:30,currency:'INR',exchangeRate:1},customerDetails:{customerName:'Invoice Test Customer',companyName:'Invoice Test Co'},billTo:{name:'Invoice Test Co'},shipTo:{name:'Invoice Test Co'},companyDetails:{},items:[{itemName:'Test item',quantity:2,unitPrice:15,amount:30,gst:'0'}],totals:{subtotal:30,grandTotal:30},currency:'INR',amountINR:30,receivedINR:0,balanceINR:30};
  const createToken=randomUUID();const created=await api('/api/customer-invoices',{method:'POST',body:JSON.stringify({data:payload,createToken})});assert(created.status===201&&created.body.record.version===1,'Create returns a PostgreSQL-confirmed invoice');
  const retry=await api('/api/customer-invoices',{method:'POST',body:JSON.stringify({data:payload,createToken})});assert(retry.status===200&&retry.body.duplicate,'Create retry is idempotent');
  const actual=await pool.query('SELECT version,customer_name,grand_total FROM customer_invoices WHERE invoice_number=$1',[number]);const lines=await pool.query('SELECT count(*)::int AS n FROM customer_invoice_items WHERE invoice_number=$1',[number]);assert(actual.rowCount===1&&actual.rows[0].customer_name==='Invoice Test Co'&&Number(actual.rows[0].grand_total)===30&&lines.rows[0].n===1,'PostgreSQL invoice and normalized item rows are persisted');
  assert((await api('/api/customer-invoices')).body.records.some((r)=>r.reference===number),'List/refresh reads Customer Invoice from PostgreSQL');
  const a={...payload,invoiceDetails:{...payload.invoiceDetails,amountReceived:5,balanceDue:25,paymentStatus:'Partial'},amountINR:30,receivedINR:5,balanceINR:25};const b={...payload,invoiceDetails:{...payload.invoiceDetails,notes:'Concurrent edit'}};
  const edits=await Promise.all([a,b].map((data)=>api(`/api/customer-invoices/${number}`,{method:'PUT',body:JSON.stringify({data,version:1})})));assert(edits.filter(r=>r.status===200).length===1&&edits.filter(r=>r.status===409).length===1,'Concurrent invoice edits reject the stale version');
  const row=await pool.query('SELECT version,payload FROM customer_invoices WHERE invoice_number=$1',[number]);assert(Number(row.rows[0].version)===2,'Database records one winning version update');
  assert((await api('/api/state/customerInvoiceHistory',{method:'PUT',body:JSON.stringify({data:[]})})).status===400,'Generic erp_state API rejects invoice history writes');
  const deleted=await api(`/api/customer-invoices/${number}`,{method:'DELETE',body:JSON.stringify({version:2,reason:'isolated integration test'})});assert(deleted.status===200,'Admin soft-delete is confirmed');
  const deletion=await pool.query('SELECT deleted_at,deleted_by,delete_reason FROM customer_invoices WHERE invoice_number=$1',[number]);assert(deletion.rows[0].deleted_at&&deletion.rows[0].deleted_by&&deletion.rows[0].delete_reason,'Deletion history is durable in PostgreSQL');
  const legacyNumber=`CIT-LEG-${Date.now()}`;const legacy={...payload,invoiceDetails:{...payload.invoiceDetails,invoiceNumber:legacyNumber}};
  await pool.query("INSERT INTO erp_state(storage_key,data) VALUES('customerInvoiceHistory',$1::jsonb) ON CONFLICT(storage_key) DO UPDATE SET data=erp_state.data || EXCLUDED.data",[JSON.stringify([{reference:number,payload},{reference:legacyNumber,payload:legacy}])]);
  const preview=await api('/api/customer-invoices/migration-preview');assert(preview.status===200&&preview.body.counts.eligible===1&&preview.body.counts.deleted>=1,'Admin legacy preview separates new eligible and tombstoned invoice IDs');
  const imported=await api('/api/customer-invoices/migration-preview/import-missing',{method:'POST',body:JSON.stringify({records:[legacy]})});assert(imported.status===200&&imported.body.imported.includes(legacyNumber),'Admin-confirmed import inserts a new legacy invoice');
  assert((await pool.query('SELECT 1 FROM customer_invoices WHERE invoice_number=$1 AND deleted_at IS NULL',[legacyNumber])).rowCount===1,'Imported legacy invoice is present in PostgreSQL');
  const audit=await pool.query('SELECT action FROM customer_invoice_audit WHERE invoice_number=$1',[number]);assert(audit.rows.some(r=>r.action==='CREATE')&&audit.rows.some(r=>r.action==='UPDATE')&&audit.rows.some(r=>r.action==='SOFT_DELETE'),'Create, edit and deletion audit history is retained');
  assert((await api(`/api/customer-invoices/${number}`)).status===404,'Deleted invoice is excluded from active reads');
  await stop();await start();assert((await api(`/api/customer-invoices/${number}`)).status===404,'Deleted invoice remains absent after Express restart');
  console.log(`Customer Invoice PostgreSQL integration: ${assertions} passed, 0 failed.`);
}catch(error){console.error(`Customer Invoice integration failed after ${assertions}: ${error.stack||error.message}`);process.exitCode=1;}finally{await stop();await pool.end();}
