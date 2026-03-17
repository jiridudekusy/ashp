import { useState } from 'react';
import styles from './Login.module.css';

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
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.brand}>ASHP</h1>
        <p className={styles.subtitle}>AI Security HTTP Proxy</p>
        <form onSubmit={handleSubmit}>
          <label className={styles.label}>Bearer Token</label>
          <input className={styles.input} type="password" value={token} onChange={e => setToken(e.target.value)}
                 placeholder="Enter your bearer token" required />
          <button className={styles.button} type="submit">Login</button>
          {error && <p className={styles.error}>{error}</p>}
        </form>
      </div>
    </div>
  );
}
