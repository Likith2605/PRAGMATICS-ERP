/**
 * Role-Based Authentication Utility for VYAVASTA ERP
 */

export const authHeaders = () => {
  const auth = getStoredAuth();
  if (!auth?.token) return {};
  const department = auth.activeDepartment || auth.department;
  return {
    Authorization: `Bearer ${auth.token}`,
    ...(department ? { 'X-ERP-Department': department } : {})
  };
};

export const getStoredAuth = () => {
  try {
    const auth = localStorage.getItem('erp_auth');
    if (auth) {
      return JSON.parse(auth);
    }
  } catch (err) {
    console.error('Error reading auth', err);
  }
  return null;
};

export const isAdmin = () => {
  const auth = getStoredAuth();
  return Boolean(auth?.isLoggedIn && (auth?.roleKey === 'admin' || auth?.role === 'Administrator'));
};

export const isEmployee = () => {
  const auth = getStoredAuth();
  return auth?.roleKey === 'employee' || auth?.role === 'Staff / Employee';
};

export const getCurrentUser = () => {
  return getStoredAuth() || {
    isLoggedIn: false,
    email: '',
    username: 'Guest',
    role: 'Guest',
    roleKey: 'guest'
  };
};

export const setStoredAuth = (authData) => {
  localStorage.setItem('erp_auth', JSON.stringify(authData));
};

export const clearStoredAuth = () => {
  localStorage.removeItem('erp_auth');
};
