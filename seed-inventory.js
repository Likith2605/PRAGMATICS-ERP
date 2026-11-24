// Paste this in your browser console (F12 → Console) to seed 5 dummy inventory items
const dummyItems = [
  { id: "INV-001", itemCode: "PRAG-101", itemName: "MS Plate 10mm", category: "Raw Material", hsnSac: "7208", unit: "Kg", currentQty: 500, reservedQty: 0, minReorderLevel: 100, unitCost: 85, sellingPrice: 95, location: "Bay A-1" },
  { id: "INV-002", itemCode: "PRAG-102", itemName: "SS Pipe 2inch Sch40", category: "Raw Material", hsnSac: "7304", unit: "Nos", currentQty: 120, reservedQty: 0, minReorderLevel: 30, unitCost: 2200, sellingPrice: 2500, location: "Bay A-2" },
  { id: "INV-003", itemCode: "PRAG-103", itemName: "Hex Bolt M12x50 Grade 8.8", category: "Fastener", hsnSac: "7318", unit: "Nos", currentQty: 2000, reservedQty: 0, minReorderLevel: 500, unitCost: 12, sellingPrice: 15, location: "Bay B-1" },
  { id: "INV-004", itemCode: "PRAG-104", itemName: "Mild Steel Round Bar 32mm", category: "Raw Material", hsnSac: "7215", unit: "Kg", currentQty: 350, reservedQty: 0, minReorderLevel: 80, unitCost: 72, sellingPrice: 82, location: "Bay A-3" },
  { id: "INV-005", itemCode: "PRAG-105", itemName: "Welding Electrode E7018 4mm", category: "Consumable", hsnSac: "8311", unit: "Kg", currentQty: 80, reservedQty: 0, minReorderLevel: 25, unitCost: 150, sellingPrice: 180, location: "Bay C-1" }
];
localStorage.setItem('inventoryItems', JSON.stringify(dummyItems));
console.log('✅ 5 dummy inventory items added! Refresh the page to see them.');
