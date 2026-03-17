import { Outlet } from 'react-router-dom';
import { TopNav } from './TopNav.jsx';
import styles from './Layout.module.css';

export default function Layout({ pendingCount, proxyConnected, onLogout }) {
  return (
    <div className={styles.layout}>
      <TopNav pendingCount={pendingCount} proxyConnected={proxyConnected} onLogout={onLogout} />
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
