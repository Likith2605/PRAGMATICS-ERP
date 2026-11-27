import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
    ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
    : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

export const getEmployeeCount = async () => {
    const response = await fetch(`${base()}/auth/employee-count`, { headers: { ...authHeaders() } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body.error || `Employee count request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return Number(body.count) || 0;
};
