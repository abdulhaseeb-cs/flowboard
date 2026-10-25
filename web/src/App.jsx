import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session.jsx';
import Layout from './components/Layout.jsx';
import AuthPage from './pages/AuthPage.jsx';
import Home from './pages/Home.jsx';
import WorkspacePage from './pages/WorkspacePage.jsx';
import Board from './pages/Board.jsx';
import Analytics from './pages/Analytics.jsx';
import Join from './pages/Join.jsx';

function RequireAuth({ children }) {
  const { user, ready } = useSession();
  const location = useLocation();
  if (!ready) return <div className="splash"><div className="spinner" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

function NotFound() {
  return (
    <div className="empty-state page-pad">
      <h1 id="page-title">Page not found</h1>
      <p>The page you are looking for does not exist.</p>
      <a className="btn" href="/">Go home</a>
    </div>
  );
}

export default function App() {
  const { user, ready } = useSession();
  return (
    <Routes>
      <Route path="/login" element={ready && user ? <Navigate to="/" replace /> : <AuthPage mode="login" />} />
      <Route path="/register" element={ready && user ? <Navigate to="/" replace /> : <AuthPage mode="register" />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<Home />} />
        <Route path="/join/:code" element={<Join />} />
        <Route path="/w/:id" element={<WorkspacePage />} />
        <Route path="/p/:id" element={<Board />} />
        <Route path="/p/:id/analytics" element={<Analytics />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
