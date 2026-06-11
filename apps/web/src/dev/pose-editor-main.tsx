/**
 * Entry for the dev pose editor (`/pose-editor.html`). Mounts the React panel.
 * Deliberately a standalone Vite HTML entry (not an app route), so it stays out
 * of the production bundle — Vite only builds `index.html`. No StrictMode: the
 * three.js engine owns a renderer/RAF loop we don't want double-mounted in dev.
 */
import ReactDOM from 'react-dom/client';
import { PoseEditorApp } from './PoseEditorApp';
import '../index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from pose-editor.html');

ReactDOM.createRoot(rootEl).render(<PoseEditorApp />);
