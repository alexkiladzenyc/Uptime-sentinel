import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { MonitorDetailPage } from './pages/MonitorDetailPage';
import { MonitorsPage } from './pages/MonitorsPage';
import { QueuePage } from './pages/QueuePage';
import './styles.css';

function App() {
  return (
    <BrowserRouter>
      <nav className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <span className="brand-dot" aria-hidden="true" /> Uptime Sentinel
          </NavLink>
          <NavLink to="/" end>
            Monitors
          </NavLink>
          <NavLink to="/queue">Queue</NavLink>
        </div>
      </nav>
      <main className="container">
        <Routes>
          <Route path="/" element={<MonitorsPage />} />
          <Route path="/monitors/:id" element={<MonitorDetailPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
