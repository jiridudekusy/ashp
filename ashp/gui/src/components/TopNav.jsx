import { NavLink } from 'react-router-dom';
import { useTheme } from '../theme/useTheme.js';
import styles from './TopNav.module.css';

const THEME_ICONS = { light: '\u2600', dark: '\uD83C\uDF19', system: '\uD83D\uDCBB' };

export function TopNav({ pendingCount = 0, proxyConnected = false, onLogout }) {
  const { theme, cycleTheme } = useTheme();

  return (
    <nav className={styles.nav}>
      <div className={styles.brand}>ASHP</div>
      <div className={styles.tabs}>
        <NavLink to="/" end className={({ isActive }) => isActive ? styles.tabActive : styles.tab}>Dashboard</NavLink>
        <NavLink to="/rules" className={({ isActive }) => isActive ? styles.tabActive : styles.tab}>Rules</NavLink>
        <NavLink to="/logs" className={({ isActive }) => isActive ? styles.tabActive : styles.tab}>Logs</NavLink>
        <NavLink to="/approvals" className={({ isActive }) => isActive ? styles.tabActive : styles.tab}>
          Approvals
          {pendingCount > 0 && <span className={styles.badge}>{pendingCount}</span>}
        </NavLink>
      </div>
      <div className={styles.right}>
        <div className={styles.status}>
          <span className={proxyConnected ? styles.dotGreen : styles.dotRed} />
          <span className={styles.statusText}>{proxyConnected ? 'Proxy connected' : 'Proxy disconnected'}</span>
        </div>
        <button className={styles.themeBtn} onClick={cycleTheme} title={`Theme: ${theme}`}>
          {THEME_ICONS[theme]}
        </button>
        <button className={styles.logoutBtn} onClick={onLogout}>Logout</button>
      </div>
    </nav>
  );
}
