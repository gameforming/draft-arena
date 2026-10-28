import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './gui-fixes.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Draft Arena kan niet starten: het HTML-element #root ontbreekt.');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
