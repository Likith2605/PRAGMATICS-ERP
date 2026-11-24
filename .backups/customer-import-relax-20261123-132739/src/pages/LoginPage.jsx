import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';

import { setStoredAuth } from '../utils/auth.js';

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
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState('admin'); // 'admin' | 'employee'

  const handleSelectRole = (role) => {
    setSelectedTab(role);
    setErrorMessage('');
    setEmail('');
    setPassword('');
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

  const handleLogin = async (e) => {
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
    try {
      const base = window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api';
      const response = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, password, portal: selectedTab })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Unable to sign in.');
      const authData = { ...payload.user, token: payload.token, expiresAt: payload.expiresAt, loginTime: new Date().toISOString() };
      setStoredAuth(authData);
      setPassword('');
      if (onLoginSuccess) onLoginSuccess(authData);
    } catch (error) {
      setErrorMessage(error.message || 'Sign-in failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        background: '#102944',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
          fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
              alt={`${brandName} Logo`}
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
              fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
            }}
          >
            {brandName}
          </h2>
          <p
            style={{
              fontSize: '14px',
              color: '#64748b',
              margin: 0,
              fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
              fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
              fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
              fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
            }}
          >
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Form */}
        <form autoComplete="on" onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '14px',
                fontWeight: 'bold',
                color: '#334155',
                marginBottom: '6px',
                fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
              }}
            >
              Email
            </label>
            <input
              type="email"
              name="username"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder=""
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
                fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
                fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
              }}
            >
              Password
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder=""
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
                  fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
              fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
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
