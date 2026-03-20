import { useState } from 'react';
import styles from './Login.module.css';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const credentials = btoa(`${username}:${password}`);
    try {
      // Validate against a protected endpoint (not /api/status which is public)
      const res = await fetch('/api/rules', {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error('Invalid credentials');
      onLogin(credentials);
    } catch {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.brand}>ASHP</h1>
        <p className={styles.subtitle}>AI Security HTTP Proxy</p>
        <form onSubmit={handleSubmit}>
          <label className={styles.label}>Username</label>
          <input className={styles.input} type="text" value={username}
            onChange={e => setUsername(e.target.value)} placeholder="Username" required autoFocus />
          <label className={styles.label}>Password</label>
          <input className={styles.input} type="password" value={password}
            onChange={e => setPassword(e.target.value)} placeholder="Password" required />
          <button className={styles.button} type="submit" disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
          {error && <p className={styles.error}>{error}</p>}
        </form>
      </div>
    </div>
  );
}
