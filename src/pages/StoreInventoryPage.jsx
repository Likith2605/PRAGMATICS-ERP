import React from 'react';
import { useParams } from 'react-router-dom';
import { hasPermission } from '../utils/permissions.js';
import { resolveInventoryViewForUser } from '../utils/inventoryViews.js';
import InventoryPage from './InventoryPage.jsx';

// Thin wrapper that reuses the Admin Inventory page (same data, logic and UI) for
// the Store login. The route param selects which view of the shared inventory to show.
const StoreInventoryPage = ({ view: viewProp }) => {
  const params = useParams();
  const rawView = viewProp !== undefined ? viewProp : params.view;
  const view = resolveInventoryViewForUser(rawView, hasPermission('inventory.adjust'));
  return <InventoryPage view={view} />;
};

export default StoreInventoryPage;