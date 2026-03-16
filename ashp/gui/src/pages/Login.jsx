import { useState } from 'react';

export default function Login({ onLogin }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      const res = await fetch('/api/status', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) { onLogin(token); }
      else { setError('Invalid token'); }
    } catch { setError('Connection failed'); }
  }

  return (
    <div className="login">
      <h1>ASHP</h1>
      <form onSubmit={handleSubmit}>
        <input type="password" value={token} onChange={e => setToken(e.target.value)}
               placeholder="Bearer token" required />
        <button type="submit">Login</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
