import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession, useToast } from '../lib/session.jsx';
import { Spinner } from '../components/ui.jsx';

// /join/:code — joins the workspace, then redirects into it
export default function Join() {
  const { code } = useParams();
  const { refreshWorkspaces } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.post('/workspaces/join', { code })
      .then(async ({ workspace, alreadyMember }) => {
        if (cancelled) return;
        await refreshWorkspaces();
        toast(alreadyMember ? `You're already in ${workspace.name}` : `Joined ${workspace.name}`);
        navigate(`/w/${workspace.id}`, { replace: true });
      })
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, [code, navigate, refreshWorkspaces, toast]);

  if (!error) return <div className="page-pad"><Spinner /></div>;
  return (
    <div className="empty-state page-pad" data-testid="join-error">
      <h1 id="page-title">Couldn't join</h1>
      <p>{error.message}</p>
      <Link className="btn" to="/">Back home</Link>
    </div>
  );
}
