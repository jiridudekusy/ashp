/**
 * @file Top navigation bar with route tabs, proxy status indicator,
 * pending approval badge, theme toggle, and logout button.
 *
 * The proxy status dot (green/red) reflects the last known proxy connection
 * state from /api/status. The pending approval badge on the Approvals tab
 * is driven by ApprovalTracker in App.jsx via SSE events.
 */
import { NavLink } from 'react-router-dom';
import { useTheme } from '../theme/useTheme.js';
import styles from './TopNav.module.css';

const THEME_ICONS = { light: '\u2600', dark: '\uD83C\uDF19', system: '\uD83D\uDCBB' };

/**
 * @param {Object} props
 * @param {number} props.pendingCount - Number of pending approvals (shown as badge)
 * @param {boolean} props.proxyConnected - Whether the Go proxy is connected
 * @param {Function} props.onLogout - Called when logout is clicked
 */
const GITHUB_REPO = 'https://github.com/jiridudekusy/ashp';

export function TopNav({ pendingCount = 0, proxyConnected = false, onLogout, version, commit }) {
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
        <NavLink to="/agents" className={({ isActive }) => isActive ? styles.tabActive : styles.tab}>Agents</NavLink>
      </div>
      <div className={styles.right}>
        {version && version !== 'dev' && (
          <span className={styles.version}>
            <a href={`${GITHUB_REPO}/releases/tag/${version}`} target="_blank" rel="noopener noreferrer" className={styles.versionLink}>{version}</a>
            {commit && commit !== 'unknown' && (
              <a href={`${GITHUB_REPO}/commit/${commit}`} target="_blank" rel="noopener noreferrer" className={styles.commitLink}>{commit.slice(0, 7)}</a>
            )}
          </span>
        )}
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
