/**
 * Role-Based Authentication Utility for Pragmatics ERP
 */

export const ACCOUNTS = {
  admin: {
    email: 'admin@gmail.com',
    password: 'Admin@1234',
    name: 'Administrator',
    role: 'Administrator',
    roleKey: 'admin'
  },
  employee: {
    email: 'employee@gmail.com',
    password: 'Staff@1234',
    name: 'Staff Employee',
    role: 'Staff / Employee',
    roleKey: 'employee'
  }
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
  return !auth?.roleKey || auth?.roleKey === 'admin' || auth?.role === 'Administrator';
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
