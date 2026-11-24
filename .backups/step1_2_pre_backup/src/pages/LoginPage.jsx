import React, { useState } from 'react';
import logoUrl from '../assets/logo.png';

import { ACCOUNTS, setStoredAuth } from '../utils/auth.js';
import { authenticateEmployee } from '../utils/storeService.js';

export const DEFAULT_ADMIN_EMAIL = ACCOUNTS.admin.email;
export const DEFAULT_ADMIN_PASSWORD = ACCOUNTS.admin.password;
export const DEFAULT_EMPLOYEE_EMAIL = ACCOUNTS.employee.email;
export const DEFAULT_EMPLOYEE_PASSWORD = ACCOUNTS.employee.password;

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

const LoginPage = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState(DEFAULT_ADMIN_EMAIL);
  const [password, setPassword] = useState(DEFAULT_ADMIN_PASSWORD);
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState('admin'); // 'admin' | 'employee'

  const handleSelectRole = (role) => {
    setSelectedTab(role);
    setErrorMessage('');
    if (role === 'admin') {
      setEmail(ACCOUNTS.admin.email);
      setPassword(ACCOUNTS.admin.password);
    } else {
      setEmail('');
      setPassword('');
    }
  };

  // Validation functions
  const validateEmail = (val) => {
    const trimmed = val.trim();
    const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;
    return gmailRegex.test(trimmed);
  };

  const validatePassword = (val) => {
    const hasMinLength = val.length >= 8;
    const hasUpperCase = /[A-Z]/.test(val);
    const hasLowerCase = /[a-z]/.test(val);
    const hasNumber = /[0-9]/.test(val);
    const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(val);

    if (!hasMinLength) {
      return 'Password must be at least 8 characters long.';
    }
    if (!hasUpperCase) {
      return 'Password must contain at least one uppercase letter (A-Z).';
    }
    if (!hasLowerCase) {
      return 'Password must contain at least one lowercase letter (a-z).';
    }
    if (!hasNumber) {
      return 'Password must contain at least one numeric digit (0-9).';
    }
    if (!hasSpecialChar) {
      return 'Password must contain at least one special character (!@#$%^&* etc.).';
    }
    return null;
  };

  const handleLogin = (e) => {
    e.preventDefault();
    setErrorMessage('');

    // 1. Email validation
    if (!validateEmail(email)) {
      setErrorMessage('Email must be a valid address ending with @gmail.com');
      return;
    }

    // 2. Password validation
    const passwordError = validatePassword(password);
    if (passwordError) {
      setErrorMessage(passwordError);
      return;
    }

    setIsLoading(true);

    const cleanEmail = email.trim().toLowerCase();
    const isAdminAccount = selectedTab === 'admin';

    setTimeout(() => {
      if (isAdminAccount) {
        if (cleanEmail !== ACCOUNTS.admin.email.toLowerCase() || password !== ACCOUNTS.admin.password) {
          setIsLoading(false);
          setErrorMessage('Invalid administrator login ID or password.');
          return;
        }
        const authData = {
          isLoggedIn: true,
          email: ACCOUNTS.admin.email,
          username: ACCOUNTS.admin.name,
          role: 'Administrator',
          roleKey: 'admin',
          department: 'Admin',
          employeeId: '-',
          loginTime: new Date().toISOString()
        };
        setStoredAuth(authData);
        if (onLoginSuccess) onLoginSuccess(authData);
        return;
      }

      // Employee: verify against the Employee Master (email = Login ID)
      const employee = authenticateEmployee(cleanEmail, password);

      if (!employee) {
        setIsLoading(false);
        setErrorMessage('Invalid Login ID or password. Ask your administrator for your credentials.');
        return;
      }

      const authData = {
        isLoggedIn: true,
        email: employee.email,
        username: employee.name,
        role: employee.role || 'Staff / Employee',
        roleKey: employee.roleKey || 'employee',
        employeeId: employee.employeeId,
        department: employee.department,
        designation: employee.designation || '',
        loginTime: new Date().toISOString()
      };
      setStoredAuth(authData);
      if (onLoginSuccess) onLoginSuccess(authData);
    }, 250);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: '"Times New Roman", Times, serif'
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '430px',
          background: '#ffffff',
          borderRadius: '16px',
          padding: '38px 34px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.25)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          fontFamily: '"Times New Roman", Times, serif'
        }}
      >
        {/* Header Branding */}
        <div style={{ textAlign: 'center', marginBottom: '26px' }}>
          <div
            style={{
              width: '74px',
              height: '74px',
              margin: '0 auto 14px',
              borderRadius: '14px',
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              padding: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <img
              src={logoUrl}
              alt="PRAGMATIC ENGINEERS Logo"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </div>
          <h2
            style={{
              fontSize: '22px',
              fontWeight: 'bold',
              color: '#0f172a',
              margin: '0 0 5px',
              letterSpacing: '0.3px',
              fontFamily: '"Times New Roman", Times, serif'
            }}
          >
            PRAGMATIC ENGINEERS
          </h2>
          <p
            style={{
              fontSize: '14px',
              color: '#64748b',
              margin: 0,
              fontFamily: '"Times New Roman", Times, serif'
            }}
          >
{/* Enterprise Resource Planning (ERP) System */}
          </p>
        </div>

        {/* Role Tabs */}
        <div
          style={{
            display: 'flex',
            background: '#f1f5f9',
            padding: '4px',
            borderRadius: '10px',
            marginBottom: '20px',
            gap: '4px'
          }}
        >
          <button
            type="button"
            onClick={() => handleSelectRole('admin')}
            style={{
              flex: 1,
              padding: '9px 12px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '700',
              border: 'none',
              cursor: 'pointer',
              background: selectedTab === 'admin' ? '#2563eb' : 'transparent',
              color: selectedTab === 'admin' ? '#ffffff' : '#475569',
              transition: 'all 0.2s ease',
              boxShadow: selectedTab === 'admin' ? '0 2px 6px rgba(37, 99, 235, 0.3)' : 'none',
              fontFamily: '"Times New Roman", Times, serif'
            }}
          >
            Admin Portal
          </button>
          <button
            type="button"
            onClick={() => handleSelectRole('employee')}
            style={{
              flex: 1,
              padding: '9px 12px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '700',
              border: 'none',
              cursor: 'pointer',
              background: selectedTab === 'employee' ? '#0f766e' : 'transparent',
              color: selectedTab === 'employee' ? '#ffffff' : '#475569',
              transition: 'all 0.2s ease',
              boxShadow: selectedTab === 'employee' ? '0 2px 6px rgba(15, 118, 110, 0.3)' : 'none',
              fontFamily: '"Times New Roman", Times, serif'
            }}
          >
            Employee Portal
          </button>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '11px 14px',
              borderRadius: '8px',
              fontSize: '13.5px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
              lineHeight: '1.4',
              fontFamily: '"Times New Roman", Times, serif'
            }}
          >
            <span style={{ fontSize: '15px' }}>⚠️</span>
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '14px',
                fontWeight: 'bold',
                color: '#334155',
                marginBottom: '6px',
                fontFamily: '"Times New Roman", Times, serif'
              }}
            >
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder={selectedTab === 'admin' ? ACCOUNTS.admin.email : 'employee@company.com'}
              style={{
                width: '100%',
                height: '42px',
                padding: '0 12px',
                borderRadius: '8px',
                border: '1px solid #cbd5e1',
                fontSize: '14.5px',
                color: '#0f172a',
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: '"Times New Roman", Times, serif'
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '14px',
                fontWeight: 'bold',
                color: '#334155',
                marginBottom: '6px',
                fontFamily: '"Times New Roman", Times, serif'
              }}
            >
              Password
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder={selectedTab === 'admin' ? ACCOUNTS.admin.password : 'Enter your password'}
                style={{
                  width: '100%',
                  height: '42px',
                  padding: '0 40px 0 12px',
                  borderRadius: '8px',
                  border: '1px solid #cbd5e1',
                  fontSize: '14.5px',
                  color: '#0f172a',
                  outline: 'none',
                  boxSizing: 'border-box',
                  fontFamily: '"Times New Roman", Times, serif'
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#64748b',
                  fontSize: '15px',
                  padding: '4px'
                }}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            style={{
              width: '100%',
              height: '44px',
              background: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '15px',
              fontWeight: 'bold',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              marginTop: '6px',
              transition: 'background 0.15s ease',
              boxShadow: '0 4px 12px rgba(37, 99, 235, 0.25)',
              fontFamily: '"Times New Roman", Times, serif'
            }}
          >
            {isLoading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
