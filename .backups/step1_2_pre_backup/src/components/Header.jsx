import React from 'react';

const Header = () => {
  return (
    <header className="app-header">
      <div className="header-title">
        <h2>Vyavasta</h2>
      </div>
      <div className="header-actions">
        <div className="search-box">
          <input type="text" placeholder="Search quotations, projects..." />
        </div>
        <button className="button-primary">Sign Out</button>
      </div>
    </header>
  );
};

export default Header;
