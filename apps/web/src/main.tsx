import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';
import { initSentry } from './sentry';
import './index.css';

initSentry();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
