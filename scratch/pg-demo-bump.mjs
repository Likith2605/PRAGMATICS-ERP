// Phase 2 demo step: simulate "User B on another computer" saving a newer
// version of INV-DEMO-1793161723734 directly through the API, so the demo
// browser's next save of that same item arrives with a stale version.
import 'dotenv/config';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scratch/pg-demo-bump.mjs <recordId>');
  process.exit(1);
}

const res = await fetch(`http://localhost:3001/api/records/inventoryItems`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    records: [{
      id: target,
      data: { id: target, itemCode: 'PRAG-D1', itemName: 'DEMO — CHANGED BY USER B (other computer)', category: 'Raw Material', unit: 'Kg', currentQty: 999, minReorderLevel: 50, unitCost: 90, sellingPrice: 100, location: 'Bay D-1' },
      version: 1
    }],
    updatedBy: 'User B (other computer)'
  })
});
const payload = await res.json();
console.log('User B save result:', JSON.stringify(payload, null, 1));
