# GUI Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely redesign the ASHP admin GUI with proper styling, theming, and a new smart rule builder feature.

**Architecture:** CSS Modules co-located with each component + shared CSS custom properties for theming. All existing React components get restyled in-place. New shared components (DetailPanel, SmartRuleBuilder, Modal) extracted. Theme switcher (light/dark/system) stored in localStorage.

**Tech Stack:** React 19, React Router 7, CSS Modules, CSS Custom Properties, Vite 6, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-gui-redesign-design.md`

---

## File Structure

### New files to create:
```
gui/src/
  theme/
    variables.css             ← CSS custom properties for light/dark themes
    global.css                ← Reset + base styles
    useTheme.js               ← Hook: read/write theme preference (light/dark/system)
    useTheme.test.js          ← Tests for theme hook
  components/
    TopNav.jsx                ← Shared top navigation bar
    TopNav.module.css
    Modal.jsx                 ← Reusable modal overlay
    Modal.module.css
    Modal.test.jsx            ← Modal tests
    Badge.jsx                 ← Decision/status badge (allow/deny/hold)
    Badge.module.css
    DetailPanel.jsx           ← Shared request detail with tabs (Info/Request Body/Response Body)
    DetailPanel.module.css
    DetailPanel.test.jsx      ← DetailPanel tests
    JsonViewer.jsx            ← Simple JSON syntax highlighter using CSS variables
    JsonViewer.module.css
    SmartRuleBuilder.jsx      ← Modal for creating rules from request with pattern suggestions
    SmartRuleBuilder.module.css
    SmartRuleBuilder.test.jsx ← SmartRuleBuilder tests
    SegmentedControl.jsx      ← Toggle button group for filters
    SegmentedControl.module.css
    Toast.jsx                 ← Error/success notification
    Toast.module.css
    Layout.module.css
    RuleForm.module.css
    ApprovalCard.module.css
  pages/
    Login.module.css
    Dashboard.module.css
    Rules.module.css
    Logs.module.css
    Approvals.module.css
    ApprovalCard.module.css
```

### Existing files to modify:
```
gui/index.html                ← Add data-theme="light" to prevent FOUC
gui/src/main.jsx              ← Import variables.css + global.css
gui/src/App.jsx               ← Wire pendingCount, proxyConnected, sseConnected to Layout; pass events to Logs route
gui/src/api/useSSE.js         ← Expose connected/disconnected state via onConnect/onDisconnect callbacks
gui/src/components/Layout.jsx ← Replace with TopNav-based layout
gui/src/pages/Login.jsx       ← Restyle with CSS Module
gui/src/pages/Dashboard.jsx   ← Status cards + activity feed redesign
gui/src/pages/Rules.jsx       ← Table redesign + read-only mode + add "hold" action option
gui/src/pages/Logs.jsx        ← Split view + filters + DetailPanel + read ?id= query param
gui/src/pages/Approvals.jsx   ← Split view + countdown + DetailPanel
gui/src/components/RuleForm.jsx   ← Restyle as modal form + add "hold" action option
gui/src/components/ApprovalCard.jsx ← Restyle
```

---

### Task 1: Theme System

**Files:**
- Create: `gui/src/theme/variables.css`
- Create: `gui/src/theme/useTheme.js`
- Create: `gui/src/theme/useTheme.test.js`
- Modify: `gui/src/main.jsx`
- Modify: `gui/index.html`

- [ ] **Step 1: Write the theme hook test**

```js
// gui/src/theme/useTheme.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme.js';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to light', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('dark'));
    expect(localStorage.getItem('ashp-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('reads from localStorage on mount', () => {
    localStorage.setItem('ashp-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
  });

  it('cycles through light → dark → system', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe('dark');
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe('system');
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe('light');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/theme/useTheme.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create variables.css**

```css
/* gui/src/theme/variables.css */
:root,
[data-theme="light"] {
  /* Accent */
  --color-accent: #3b82f6;
  --color-accent-hover: #2563eb;
  --color-accent-light: #eff6ff;
  --color-accent-border: #bfdbfe;

  /* Status: allow */
  --color-allow: #16a34a;
  --color-allow-bg: #dcfce7;
  --color-allow-border: #86efac;

  /* Status: deny */
  --color-deny: #dc2626;
  --color-deny-bg: #fef2f2;
  --color-deny-border: #fca5a5;

  /* Status: hold */
  --color-hold: #d97706;
  --color-hold-bg: #fef3c7;
  --color-hold-border: #fcd34d;

  /* Neutrals */
  --color-text: #0f172a;
  --color-text-secondary: #64748b;
  --color-text-muted: #94a3b8;
  --color-border: #e2e8f0;
  --color-border-light: #f1f5f9;
  --color-bg-page: #f8fafc;
  --color-bg-card: #ffffff;
  --color-bg-hover: #f1f5f9;

  /* Misc */
  --color-success: #22c55e;
  --radius: 6px;
  --radius-lg: 8px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.1);
  --shadow-lg: 0 8px 30px rgba(0,0,0,0.15);

  /* Code viewer */
  --color-code-bg: #f8fafc;
  --color-code-border: #e2e8f0;
  --color-code-text: #334155;
  --color-code-key: #0369a1;
  --color-code-string: #16a34a;
  --color-code-number: #d97706;
}

[data-theme="dark"] {
  --color-accent: #60a5fa;
  --color-accent-hover: #93bbfd;
  --color-accent-light: #1e3a5f;
  --color-accent-border: #1e40af;

  --color-allow: #4ade80;
  --color-allow-bg: #052e16;
  --color-allow-border: #166534;

  --color-deny: #f87171;
  --color-deny-bg: #450a0a;
  --color-deny-border: #991b1b;

  --color-hold: #fbbf24;
  --color-hold-bg: #451a03;
  --color-hold-border: #92400e;

  --color-text: #f1f5f9;
  --color-text-secondary: #94a3b8;
  --color-text-muted: #64748b;
  --color-border: #334155;
  --color-border-light: #1e293b;
  --color-bg-page: #0f172a;
  --color-bg-card: #1e293b;
  --color-bg-hover: #334155;

  --color-success: #4ade80;

  --color-code-bg: #1e293b;
  --color-code-border: #334155;
  --color-code-text: #e2e8f0;
  --color-code-key: #7dd3fc;
  --color-code-string: #86efac;
  --color-code-number: #fbbf24;
}
```

- [ ] **Step 4: Implement useTheme hook**

```js
// gui/src/theme/useTheme.js
import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'ashp-theme';
const CYCLE = ['light', 'dark', 'system'];

function applyTheme(theme) {
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) || 'light';
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((t) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  const cycleTheme = useCallback(() => {
    const idx = CYCLE.indexOf(theme);
    setTheme(CYCLE[(idx + 1) % CYCLE.length]);
  }, [theme, setTheme]);

  return { theme, setTheme, cycleTheme };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gui && npx vitest run src/theme/useTheme.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Add data-theme to index.html**

In `gui/index.html`, add `data-theme="light"` to the `<html>` tag to prevent flash of unstyled content:
```html
<html lang="en" data-theme="light">
```

- [ ] **Step 7: Import variables.css in main.jsx**

Add to top of `gui/src/main.jsx`:
```js
import './theme/variables.css';
```

- [ ] **Step 8: Modify useSSE.js to expose connection state**

Add `onConnect` and `onDisconnect` callbacks to the `useSSE` hook options. In `gui/src/api/useSSE.js`, update to call `opts.onConnect?.()` when EventSource opens and `opts.onDisconnect?.()` on error/close. This allows the app to track SSE connection state for the "Proxy connected/disconnected" indicator.

```js
// In the connect function, after creating EventSource:
es.onopen = () => opts.onConnect?.();
es.onerror = () => {
  opts.onDisconnect?.();
  // existing reconnect logic
};
```

- [ ] **Step 9: Commit**

```bash
git add gui/src/theme/ gui/src/main.jsx gui/index.html gui/src/api/useSSE.js
git commit -m "feat(gui): add theme system with CSS variables and useTheme hook"
```

---

### Task 2: Modal Component

**Files:**
- Create: `gui/src/components/Modal.jsx`
- Create: `gui/src/components/Modal.module.css`
- Create: `gui/src/components/Modal.test.jsx`

- [ ] **Step 1: Write Modal tests**

```jsx
// gui/src/components/Modal.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal.jsx';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Modal open={false} onClose={() => {}}>Content</Modal>);
    expect(container.innerHTML).toBe('');
  });

  it('renders children when open', () => {
    render(<Modal open={true} onClose={() => {}}>Hello Modal</Modal>);
    expect(screen.getByText('Hello Modal')).toBeTruthy();
  });

  it('calls onClose when overlay clicked', () => {
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose}>Content</Modal>);
    fireEvent.click(screen.getByTestId('modal-overlay'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when dialog content clicked', () => {
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose}><div>Inner</div></Modal>);
    fireEvent.click(screen.getByText('Inner'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/components/Modal.test.jsx`
Expected: FAIL

- [ ] **Step 3: Implement Modal**

```jsx
// gui/src/components/Modal.jsx
import styles from './Modal.module.css';

export function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className={styles.overlay} data-testid="modal-overlay" onClick={onClose}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        {title && (
          <div className={styles.header}>
            <h3 className={styles.title}>{title}</h3>
            <button className={styles.close} onClick={onClose}>×</button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
```

```css
/* gui/src/components/Modal.module.css */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dialog {
  background: var(--color-bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 480px;
  max-height: 90vh;
  overflow-y: auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0 4px;
}

.body {
  padding: 20px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run src/components/Modal.test.jsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gui/src/components/Modal.*
git commit -m "feat(gui): add reusable Modal component"
```

---

### Task 3: Badge and SegmentedControl Components

**Files:**
- Create: `gui/src/components/Badge.jsx`
- Create: `gui/src/components/Badge.module.css`
- Create: `gui/src/components/SegmentedControl.jsx`
- Create: `gui/src/components/SegmentedControl.module.css`

- [ ] **Step 1: Create Badge component**

```jsx
// gui/src/components/Badge.jsx
import styles from './Badge.module.css';

const VARIANTS = {
  allow: styles.allow, allowed: styles.allow,
  deny: styles.deny, denied: styles.deny,
  hold: styles.hold, held: styles.hold,
};

export function Badge({ variant, children }) {
  const cls = VARIANTS[variant] || '';
  return <span className={`${styles.badge} ${cls}`}>{children || variant}</span>;
}
```

```css
/* gui/src/components/Badge.module.css */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
  min-width: 44px;
  justify-content: center;
}

.allow {
  background: var(--color-allow-bg);
  color: var(--color-allow);
}

.deny {
  background: var(--color-deny-bg);
  color: var(--color-deny);
}

.hold {
  background: var(--color-hold-bg);
  color: var(--color-hold);
}
```

- [ ] **Step 2: Create SegmentedControl component**

```jsx
// gui/src/components/SegmentedControl.jsx
import styles from './SegmentedControl.module.css';

export function SegmentedControl({ options, value, onChange }) {
  return (
    <div className={styles.group}>
      {options.map(opt => (
        <button
          key={opt.value}
          className={`${styles.option} ${value === opt.value ? styles.active : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
```

```css
/* gui/src/components/SegmentedControl.module.css */
.group {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--color-bg-card);
}

.option {
  padding: 4px 10px;
  font-size: 11px;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-left: 1px solid var(--color-border);
}

.option:first-child {
  border-left: none;
}

.active {
  background: var(--color-accent);
  color: white;
}
```

- [ ] **Step 3: Commit**

```bash
git add gui/src/components/Badge.* gui/src/components/SegmentedControl.*
git commit -m "feat(gui): add Badge and SegmentedControl components"
```

---

### Task 4: Toast Component

**Files:**
- Create: `gui/src/components/Toast.jsx`
- Create: `gui/src/components/Toast.module.css`

- [ ] **Step 1: Create Toast component**

```jsx
// gui/src/components/Toast.jsx
import { useState, useCallback, useRef } from 'react';
import styles from './Toast.module.css';

export function useToast() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const addToast = useCallback((message, type = 'error') => {
    const id = ++idRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  return { toasts, addToast };
}

export function ToastContainer({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className={styles.container}>
      {toasts.map(t => (
        <div key={t.id} className={`${styles.toast} ${styles[t.type] || ''}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
```

```css
/* gui/src/components/Toast.module.css */
.container {
  position: fixed;
  top: 60px;
  right: 16px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  padding: 10px 16px;
  border-radius: var(--radius);
  font-size: 13px;
  box-shadow: var(--shadow-md);
  animation: slideIn 0.2s ease-out;
}

.error {
  background: var(--color-deny-bg);
  color: var(--color-deny);
  border: 1px solid var(--color-deny-border);
}

.success {
  background: var(--color-allow-bg);
  color: var(--color-allow);
  border: 1px solid var(--color-allow-border);
}

@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
```

- [ ] **Step 2: Commit**

```bash
git add gui/src/components/Toast.*
git commit -m "feat(gui): add Toast notification component"
```

---

### Task 5: TopNav + Layout Redesign

**Files:**
- Create: `gui/src/components/TopNav.jsx`
- Create: `gui/src/components/TopNav.module.css`
- Create: `gui/src/components/Layout.module.css`
- Modify: `gui/src/components/Layout.jsx`
- Modify: `gui/src/App.jsx`

- [ ] **Step 1: Create TopNav component**

```jsx
// gui/src/components/TopNav.jsx
import { NavLink } from 'react-router-dom';
import { useTheme } from '../theme/useTheme.js';
import styles from './TopNav.module.css';

const THEME_ICONS = { light: '☀', dark: '🌙', system: '💻' };

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
```

```css
/* gui/src/components/TopNav.module.css */
.nav {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 20px;
  height: 48px;
  background: var(--color-bg-card);
  border-bottom: 1px solid var(--color-border);
}

.brand {
  font-weight: 700;
  font-size: 15px;
  color: var(--color-text);
}

.tabs {
  display: flex;
  gap: 2px;
  height: 100%;
}

.tab, .tabActive {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
  font-size: 13px;
  text-decoration: none;
  color: var(--color-text-secondary);
  border-bottom: 2px solid transparent;
  height: 100%;
}

.tabActive {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
  font-weight: 500;
}

.badge {
  background: var(--color-deny);
  color: white;
  font-size: 10px;
  min-width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 4px;
}

.right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dotGreen, .dotRed {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dotGreen { background: var(--color-success); }
.dotRed { background: var(--color-deny); }

.statusText {
  font-size: 11px;
  color: var(--color-text-muted);
}

.themeBtn {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 4px 8px;
  cursor: pointer;
  font-size: 14px;
}

.logoutBtn {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 4px 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.logoutBtn:hover {
  background: var(--color-bg-hover);
}
```

- [ ] **Step 2: Update Layout.jsx to use TopNav**

Replace `gui/src/components/Layout.jsx` with:

```jsx
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
```

```css
/* gui/src/components/Layout.module.css */
.layout {
  min-height: 100vh;
  background: var(--color-bg-page);
  color: var(--color-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.main {
  padding: 20px;
}
```

- [ ] **Step 3: Update App.jsx to pass props to Layout**

Modify `gui/src/App.jsx` to wire state through to Layout and pages:

```jsx
// In the authenticated branch of App, add state:
const [pendingCount, setPendingCount] = useState(0);
const [sseConnected, setSseConnected] = useState(false);
const [proxyConnected, setProxyConnected] = useState(false);

// Fetch initial status:
useEffect(() => {
  api.getStatus().then(s => {
    setProxyConnected(!!s.proxy?.connected);
    setPendingCount(s.pending_approvals || 0);
  }).catch(() => {});
}, [api]);

// In EventBridge, use SSE callbacks:
// onConnect: () => setSseConnected(true)
// onDisconnect: () => setSseConnected(false)
// On approval.needed event: setPendingCount(c => c + 1)
// On approval.resolved event: setPendingCount(c => Math.max(0, c - 1))

// Pass to Layout route element:
<Route element={<Layout pendingCount={pendingCount} proxyConnected={proxyConnected && sseConnected} onLogout={() => { setToken(null); sessionStorage.removeItem('token'); }} />}>
  <Route index element={<Dashboard api={api} events={events} />} />
  <Route path="rules" element={<Rules api={api} events={events} />} />
  <Route path="logs" element={<Logs api={api} events={events} />} />
  <Route path="approvals" element={<Approvals api={api} events={events} />} />
</Route>
```

Note: Pass `events` to ALL page routes (including Logs) so they can listen for SSE updates.

- [ ] **Step 4: Verify app renders with new nav**

Run: `cd gui && npm run dev` — visually verify the top nav appears with tabs, status, theme switcher, and logout.

- [ ] **Step 5: Commit**

```bash
git add gui/src/components/TopNav.* gui/src/components/Layout.* gui/src/App.jsx
git commit -m "feat(gui): redesign layout with TopNav, theme switcher, and proxy status"
```

---

### Task 6: Login Page Redesign

**Files:**
- Create: `gui/src/pages/Login.module.css`
- Modify: `gui/src/pages/Login.jsx`

- [ ] **Step 1: Add CSS Module for Login**

```css
/* gui/src/pages/Login.module.css */
.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-page);
}

.card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 32px;
  width: 360px;
  box-shadow: var(--shadow-sm);
}

.brand {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
  margin-bottom: 4px;
}

.subtitle {
  font-size: 13px;
  color: var(--color-text-muted);
  margin-bottom: 24px;
}

.label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: 6px;
}

.input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--color-text);
  background: var(--color-bg-card);
  outline: none;
  box-sizing: border-box;
}

.input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent-light);
}

.button {
  width: 100%;
  padding: 8px;
  background: var(--color-accent);
  color: white;
  border: none;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  margin-top: 16px;
}

.button:hover {
  background: var(--color-accent-hover);
}

.error {
  color: var(--color-deny);
  font-size: 12px;
  margin-top: 8px;
}
```

- [ ] **Step 2: Update Login.jsx to use CSS Module**

Replace className references with `styles.xxx` imports. Keep existing logic (token validation against `/api/status`).

- [ ] **Step 3: Verify visually**

Run: `cd gui && npm run dev` — verify centered login card with styled input.

- [ ] **Step 4: Commit**

```bash
git add gui/src/pages/Login.*
git commit -m "feat(gui): redesign Login page with centered card"
```

---

### Task 7: Dashboard Page Redesign

**Files:**
- Create: `gui/src/pages/Dashboard.module.css`
- Modify: `gui/src/pages/Dashboard.jsx`

- [ ] **Step 1: Create Dashboard CSS Module**

```css
/* gui/src/pages/Dashboard.module.css */
.cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 14px;
}

.cardLabel {
  font-size: 10px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.cardValue {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text);
  margin-top: 4px;
}

.cardSub {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 4px;
}

.cardLink {
  font-size: 11px;
  color: var(--color-accent);
  cursor: pointer;
  margin-top: 4px;
}

.feed {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.feedHeader {
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.feedTitle {
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text);
}

.feedMeta {
  font-size: 11px;
  color: var(--color-text-muted);
}

.feedRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border-light);
  cursor: pointer;
}

.feedRow:hover {
  background: var(--color-bg-hover);
}

.feedRowHold {
  composes: feedRow;
  background: var(--color-hold-bg);
}

.feedUrl {
  flex: 1;
  font-size: 12px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.feedInfo {
  font-size: 11px;
  color: var(--color-text-muted);
}

.feedTime {
  font-size: 11px;
  color: var(--color-text-muted);
  min-width: 50px;
  text-align: right;
}

.statusRow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.empty {
  padding: 40px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
}
```

- [ ] **Step 2: Rewrite Dashboard.jsx**

Rewrite to include:
- 4 status cards (Proxy Status, Active Rules, Pending Approvals with link, Default Behavior)
- Live Activity feed from `GET /api/logs?limit=20`
- SSE event listener for `request.allowed`, `request.blocked` — prepend to feed
- Each row shows: `<Badge>` + method + URL + response info + relative time
- Hold entries use `.feedRowHold` class
- Rows navigate to `/logs?id={entry.id}` on click
- Empty state when no logs

- [ ] **Step 3: Verify visually**

Run: `cd gui && npm run dev` — verify 4 status cards + activity feed with colored badges.

- [ ] **Step 4: Commit**

```bash
git add gui/src/pages/Dashboard.*
git commit -m "feat(gui): redesign Dashboard with status cards and activity feed"
```

---

### Task 8: DetailPanel Component

**Files:**
- Create: `gui/src/components/DetailPanel.jsx`
- Create: `gui/src/components/DetailPanel.module.css`
- Create: `gui/src/components/DetailPanel.test.jsx`

- [ ] **Step 1: Write DetailPanel tests**

```jsx
// gui/src/components/DetailPanel.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DetailPanel } from './DetailPanel.jsx';

describe('DetailPanel', () => {
  const entry = {
    id: 1, method: 'POST', url: 'api.openai.com/v1/chat', decision: 'denied',
    timestamp: new Date().toISOString(), status_code: 0, duration_ms: 0,
    matched_rule: 'Rule #3', reason: 'rule_match',
  };

  it('renders entry info', () => {
    render(<DetailPanel entry={entry} api={{}} />);
    expect(screen.getByText(/api\.openai\.com/)).toBeTruthy();
    expect(screen.getByText('POST')).toBeTruthy();
  });

  it('shows Create Rule button', () => {
    const onCreateRule = vi.fn();
    render(<DetailPanel entry={entry} api={{}} onCreateRule={onCreateRule} />);
    fireEvent.click(screen.getByText('Create Rule from Request'));
    expect(onCreateRule).toHaveBeenCalledWith(entry);
  });

  it('switches between tabs', () => {
    render(<DetailPanel entry={entry} api={{ getRequestBody: vi.fn().mockResolvedValue('{}') }} />);
    fireEvent.click(screen.getByText('Request Body'));
    // Tab should be active (test that it doesn't crash)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/components/DetailPanel.test.jsx`
Expected: FAIL

- [ ] **Step 3: Implement DetailPanel**

```jsx
// gui/src/components/DetailPanel.jsx
import { useState, useEffect } from 'react';
import { Badge } from './Badge.jsx';
import styles from './DetailPanel.module.css';

// Extract JsonViewer to its own file: gui/src/components/JsonViewer.jsx
// Simple JSON syntax highlighter using CSS variables (--color-code-key, --color-code-string, --color-code-number)
// Implementation: parse JSON, then use a regex-based tokenizer to wrap keys, strings, numbers, and booleans
// in <span> elements with appropriate CSS classes. For non-JSON content, render as plain monospace <pre>.
//
// Example approach:
//   const highlighted = JSON.stringify(parsed, null, 2)
//     .replace(/"([^"]+)":/g, '<span class="key">"$1"</span>:')
//     .replace(/: "([^"]*?)"/g, ': <span class="string">"$1"</span>')
//     .replace(/: (\d+\.?\d*)/g, ': <span class="number">$1</span>')
//     .replace(/: (true|false|null)/g, ': <span class="bool">$1</span>');
//   return <pre className={styles.code} dangerouslySetInnerHTML={{ __html: highlighted }} />;
//
// CSS classes in JsonViewer.module.css use the theme variables:
//   .key { color: var(--color-code-key); }
//   .string { color: var(--color-code-string); }
//   .number { color: var(--color-code-number); }

import { JsonViewer } from './JsonViewer.jsx';

export function DetailPanel({ entry, api, onCreateRule, children }) {
  const [tab, setTab] = useState('info');
  const [requestBody, setRequestBody] = useState(null);
  const [responseBody, setResponseBody] = useState(null);

  useEffect(() => { setTab('info'); setRequestBody(null); setResponseBody(null); }, [entry?.id]);

  useEffect(() => {
    if (!entry || !api) return;
    if (tab === 'request' && requestBody === null) {
      api.getRequestBody?.(entry.id)?.then(setRequestBody).catch(() => setRequestBody(''));
    }
    if (tab === 'response' && responseBody === null) {
      api.getResponseBody?.(entry.id)?.then(setResponseBody).catch(() => setResponseBody(''));
    }
  }, [tab, entry, api, requestBody, responseBody]);

  if (!entry) return <div className={styles.empty}>Select an entry to view details</div>;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.headerTitle}>{entry.method} {entry.url}</span>
          <Badge variant={entry.decision}>{entry.decision}</Badge>
        </div>
        <div className={styles.headerMeta}>
          {entry.timestamp && new Date(entry.timestamp).toLocaleString()}
          {entry.status_code ? ` · ${entry.status_code}` : ''}
          {entry.duration_ms ? ` · ${entry.duration_ms}ms` : ''}
        </div>
      </div>
      <div className={styles.tabs}>
        <button className={tab === 'info' ? styles.tabActive : styles.tab} onClick={() => setTab('info')}>Info</button>
        <button className={tab === 'request' ? styles.tabActive : styles.tab} onClick={() => setTab('request')}>Request Body</button>
        <button className={tab === 'response' ? styles.tabActive : styles.tab} onClick={() => setTab('response')}>Response Body</button>
      </div>
      <div className={styles.content}>
        {tab === 'info' && (
          <div className={styles.fields}>
            <div className={styles.field}><span className={styles.fieldLabel}>URL</span><span className={styles.fieldValue}>{entry.url}</span></div>
            <div className={styles.field}><span className={styles.fieldLabel}>Method</span><span className={styles.fieldValue}>{entry.method}</span></div>
            {entry.matched_rule && <div className={styles.field}><span className={styles.fieldLabel}>Matched Rule</span><span className={styles.fieldValue}>{entry.matched_rule}</span></div>}
            {entry.reason && <div className={styles.field}><span className={styles.fieldLabel}>Reason</span><span className={styles.fieldValue}>{entry.reason}</span></div>}
          </div>
        )}
        {tab === 'request' && <JsonViewer text={requestBody} />}
        {tab === 'response' && <JsonViewer text={responseBody} />}
      </div>
      {children}
      {onCreateRule && (
        <div className={styles.footer}>
          <button className={styles.createRuleBtn} onClick={() => onCreateRule(entry)}>
            Create Rule from Request
          </button>
        </div>
      )}
    </div>
  );
}
```

Create `gui/src/components/DetailPanel.module.css` with styles for: `.panel`, `.header`, `.headerTop`, `.headerTitle`, `.headerMeta`, `.tabs`, `.tab`, `.tabActive`, `.content`, `.fields`, `.field`, `.fieldLabel`, `.fieldValue`, `.code`, `.codePlaceholder`, `.footer`, `.createRuleBtn`, `.empty`. Use CSS variables throughout.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run src/components/DetailPanel.test.jsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add gui/src/components/DetailPanel.*
git commit -m "feat(gui): add DetailPanel with tabs for Info/Request/Response body"
```

---

### Task 9: SmartRuleBuilder Component

**Files:**
- Create: `gui/src/components/SmartRuleBuilder.jsx`
- Create: `gui/src/components/SmartRuleBuilder.module.css`
- Create: `gui/src/components/SmartRuleBuilder.test.jsx`

- [ ] **Step 1: Write SmartRuleBuilder tests**

```jsx
// gui/src/components/SmartRuleBuilder.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SmartRuleBuilder, generatePatterns } from './SmartRuleBuilder.jsx';

describe('generatePatterns', () => {
  it('generates patterns from URL', () => {
    const patterns = generatePatterns('api.openai.com/v1/chat/completions');
    expect(patterns).toEqual([
      { pattern: 'api.openai.com/v1/chat/completions', label: 'exact' },
      { pattern: 'api.openai.com/v1/chat/*', label: 'path' },
      { pattern: 'api.openai.com/v1/*', label: 'api' },
      { pattern: 'api.openai.com/*', label: 'domain' },
    ]);
  });

  it('handles domain-only URL', () => {
    const patterns = generatePatterns('example.com');
    expect(patterns).toEqual([
      { pattern: 'example.com', label: 'exact' },
      { pattern: 'example.com/*', label: 'domain' },
    ]);
  });
});

describe('SmartRuleBuilder', () => {
  it('renders pattern suggestions', () => {
    render(
      <SmartRuleBuilder
        open={true}
        onClose={() => {}}
        onSubmit={() => {}}
        entry={{ method: 'POST', url: 'api.openai.com/v1/chat/completions', decision: 'denied' }}
      />
    );
    expect(screen.getByText('api.openai.com/v1/chat/*')).toBeTruthy();
    expect(screen.getByText('api.openai.com/*')).toBeTruthy();
  });

  it('calls onSubmit with selected pattern', () => {
    const onSubmit = vi.fn();
    render(
      <SmartRuleBuilder
        open={true}
        onClose={() => {}}
        onSubmit={onSubmit}
        entry={{ method: 'POST', url: 'api.openai.com/v1/chat/completions', decision: 'denied' }}
      />
    );
    fireEvent.click(screen.getByText('api.openai.com/*'));
    fireEvent.click(screen.getByText('Create Rule'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      url_pattern: 'api.openai.com/*',
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/components/SmartRuleBuilder.test.jsx`
Expected: FAIL

- [ ] **Step 3: Implement SmartRuleBuilder**

```jsx
// gui/src/components/SmartRuleBuilder.jsx
import { useState, useEffect } from 'react';
import { Modal } from './Modal.jsx';
import styles from './SmartRuleBuilder.module.css';

export function generatePatterns(url) {
  if (!url) return [];
  const clean = url.replace(/^https?:\/\//, '');
  const slashIdx = clean.indexOf('/');
  if (slashIdx === -1) {
    return [
      { pattern: clean, label: 'exact' },
      { pattern: clean + '/*', label: 'domain' },
    ];
  }
  const domain = clean.slice(0, slashIdx);
  const pathParts = clean.slice(slashIdx + 1).split('/').filter(Boolean);
  const patterns = [{ pattern: clean, label: 'exact' }];
  for (let i = pathParts.length - 1; i > 0; i--) {
    const partial = domain + '/' + pathParts.slice(0, i).join('/') + '/*';
    const label = i === pathParts.length - 1 ? 'path' : i === 1 ? 'api' : `level-${i}`;
    patterns.push({ pattern: partial, label });
  }
  patterns.push({ pattern: domain + '/*', label: 'domain' });
  return patterns;
}

export function SmartRuleBuilder({ open, onClose, onSubmit, entry }) {
  const [selectedPattern, setSelectedPattern] = useState('');
  const [method, setMethod] = useState('');
  const [action, setAction] = useState('allow');

  const patterns = entry ? generatePatterns(entry.url) : [];

  useEffect(() => {
    if (entry) {
      setSelectedPattern(patterns[0]?.pattern || '');
      setMethod(entry.method || 'ALL');
      setAction('allow');
    }
  }, [entry?.url]);

  const handleSubmit = () => {
    onSubmit({
      url_pattern: selectedPattern,
      methods: method === 'ALL' ? [] : [method],
      action,
      name: `Rule for ${selectedPattern}`,
      enabled: true,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Create Rule from Request">
      {entry && (
        <div className={styles.source}>
          {entry.method} {entry.url} → <span className={styles[entry.decision]}>{entry.decision}</span>
        </div>
      )}
      <div className={styles.section}>
        <div className={styles.label}>Pattern scope</div>
        <div className={styles.patterns}>
          {patterns.map(p => (
            <button
              key={p.pattern}
              className={selectedPattern === p.pattern ? styles.patternActive : styles.pattern}
              onClick={() => setSelectedPattern(p.pattern)}
            >
              <span className={styles.patternText}>{p.pattern}</span>
              <span className={styles.patternLabel}>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.fieldGroup}>
          <div className={styles.label}>Method</div>
          <select className={styles.select} value={method} onChange={e => setMethod(e.target.value)}>
            <option value={entry?.method}>{entry?.method}</option>
            <option value="ALL">ALL</option>
          </select>
        </div>
        <div className={styles.fieldGroup}>
          <div className={styles.label}>Action</div>
          <select className={styles.select} value={action} onChange={e => setAction(e.target.value)}>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
            <option value="hold">hold</option>
          </select>
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.submitBtn} onClick={handleSubmit}>Create Rule</button>
        <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
```

Create `gui/src/components/SmartRuleBuilder.module.css` with styles for all classes. Pattern rows styled as clickable list items with blue highlight when selected.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run src/components/SmartRuleBuilder.test.jsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gui/src/components/SmartRuleBuilder.*
git commit -m "feat(gui): add SmartRuleBuilder with pattern suggestions"
```

---

### Task 10: Rules Page Redesign

**Files:**
- Create: `gui/src/pages/Rules.module.css`
- Modify: `gui/src/pages/Rules.jsx`
- Modify: `gui/src/components/RuleForm.jsx`
- Create: `gui/src/components/RuleForm.module.css`

- [ ] **Step 1: Create Rules.module.css**

Styles for: `.header`, `.headerLeft`, `.headerRight`, `.testerGroup`, `.testerInput`, `.testerMethod`, `.testerBtn`, `.addBtn`, `.table`, `.tableHeader`, `.tableRow`, `.tableRowDisabled`, `.cellPattern`, `.testResult`, `.testResultAllow`, `.testResultDeny`, `.readOnlyBanner`, `.empty`

- [ ] **Step 2: Create RuleForm.module.css**

Styles for the modal form: `.form`, `.fieldGroup`, `.label`, `.input`, `.select`, `.toggle`, `.actions`, `.submitBtn`, `.cancelBtn`

- [ ] **Step 3: Update RuleForm.jsx**

Restyle with CSS Module. Keep all existing fields: name, url_pattern, methods, action, priority, enabled, log_request_body, log_response_body. Wrap in `<Modal>`. **Important:** Add "hold" as a third option in the action dropdown (currently only has "allow" and "deny").

- [ ] **Step 4: Rewrite Rules.jsx**

- Header with rule count, URL tester, "+ Add Rule" button
- Table with columns: name, pattern (monospace), method, action (Badge), priority, enabled (dot), Edit/Delete
- Disabled rows at 50% opacity
- Sorted by priority
- Test result banner below table (green for allow match, red for deny match)
- Read-only mode: check `status.rules_source === 'file'` → show banner, hide add/edit/delete
- "+ Add Rule" / "Edit" opens RuleForm modal
- "Delete" with confirmation

- [ ] **Step 5: Verify visually**

Run: `cd gui && npm run dev` — verify rules table, URL tester, add/edit modal.

- [ ] **Step 6: Commit**

```bash
git add gui/src/pages/Rules.* gui/src/components/RuleForm.*
git commit -m "feat(gui): redesign Rules page with table, URL tester, and modal forms"
```

---

### Task 11: Logs Page Redesign

**Files:**
- Create: `gui/src/pages/Logs.module.css`
- Modify: `gui/src/pages/Logs.jsx`

- [ ] **Step 1: Create Logs.module.css**

Styles for: `.splitView`, `.list`, `.filters`, `.logRow`, `.logRowSelected`, `.logUrl`, `.pagination`, `.paginationBtn`, `.paginationInfo`, `.detailSide`, `.newEntriesBanner`

- [ ] **Step 2: Rewrite Logs.jsx**

- Split view: log list left (flex:1), DetailPanel right (width: 380px)
- Filter bar: `<SegmentedControl>` for decision + method, text input for URL
- Log rows: Badge + method + URL (truncated) + timestamp
- Selected row: blue left border + blue tint
- Click row → load detail in right panel
- Pagination: 50 per page, prev/next, total count
- "Create Rule from Request" in DetailPanel → opens SmartRuleBuilder modal
- SSE: listen to `request.allowed` / `request.blocked` → show "New entries available" banner at top of list, click to refresh
- On mount, read `?id=` query parameter from URL — if present, auto-select that log entry and scroll it into view (used when navigating from Dashboard activity feed)

- [ ] **Step 3: Verify visually**

Run: `cd gui && npm run dev` — verify split view, filters, detail, pagination.

- [ ] **Step 4: Commit**

```bash
git add gui/src/pages/Logs.*
git commit -m "feat(gui): redesign Logs page with split view, filters, and DetailPanel"
```

---

### Task 12: Approvals Page Redesign

**Files:**
- Create: `gui/src/pages/Approvals.module.css`
- Modify: `gui/src/pages/Approvals.jsx`
- Modify: `gui/src/components/ApprovalCard.jsx` (remove or inline — replaced by list view)
- Create: `gui/src/components/ApprovalCard.module.css`

- [ ] **Step 1: Create Approvals.module.css**

Styles for: `.splitView`, `.list`, `.sectionHeader`, `.approvalRow`, `.approvalRowSelected`, `.approvalUrl`, `.approvalTime`, `.progressBar`, `.progressFill`, `.resolvedSection`, `.resolvedRow`, `.actionButtons`, `.approveBtn`, `.rejectBtn`, `.approveRuleBtn`, `.empty`

- [ ] **Step 2: Rewrite Approvals.jsx**

- Split view: approval list left, DetailPanel + action buttons right
- Pending section at top with section header + count badge
- Each pending item: method + URL, waiting time, timeout progress bar
- Progress bar: calculated from `created_at` + `hold_timeout` (from status API)
- Recently Resolved section below: tracked client-side via SSE `approval.resolved` events
- Resolved items faded (opacity: 0.5), show approved/rejected badge + time
- DetailPanel in right panel with:
  - Timeout countdown (extra `children` prop to DetailPanel)
  - 3 action buttons: Approve (green), Reject (red), Approve + Create Rule (blue)
- Approve: `resolveApproval(id, { action: 'approve' })`
- Reject: `resolveApproval(id, { action: 'reject' })`
- Approve + Create Rule: approve first, on success open SmartRuleBuilder modal
- SSE: `approval.needed` → add to pending, `approval.resolved` → move to resolved

- [ ] **Step 3: Verify visually**

Run: `cd gui && npm run dev` — verify split view, pending items with countdown, action buttons.

- [ ] **Step 4: Commit**

```bash
git add gui/src/pages/Approvals.* gui/src/components/ApprovalCard.*
git commit -m "feat(gui): redesign Approvals page with split view, countdown, and actions"
```

---

### Task 13: Global Styles + Empty/Loading States

**Files:**
- Create: `gui/src/theme/global.css`
- Modify: `gui/src/main.jsx`

- [ ] **Step 1: Create global.css**

```css
/* gui/src/theme/global.css */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--color-bg-page);
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

input, select, button, textarea {
  font-family: inherit;
}

a {
  color: var(--color-accent);
  text-decoration: none;
}
```

- [ ] **Step 2: Import in main.jsx**

Add `import './theme/global.css';` after variables import.

- [ ] **Step 3: Add empty state messages to all pages**

- Dashboard: "No recent activity" when no logs
- Rules: "No rules configured yet" when rules list empty
- Logs: "No log entries yet" when no logs
- Approvals: "No pending approvals" when queue empty

- [ ] **Step 4: Commit**

```bash
git add gui/src/theme/global.css gui/src/main.jsx gui/src/pages/
git commit -m "feat(gui): add global styles and empty state messages"
```

---

### Task 14: Integration Testing + Final Polish

**Files:**
- Modify: `gui/src/App.test.jsx`

- [ ] **Step 1: Update existing tests**

Make sure `App.test.jsx` still passes with the new Layout structure. Update imports if needed.

- [ ] **Step 2: Run full test suite**

Run: `cd gui && npm test`
Expected: All tests pass

- [ ] **Step 3: Visual QA pass**

Run: `cd gui && npm run dev` — walk through every page:
1. Login → enter token → redirects to Dashboard
2. Dashboard → 4 cards + activity feed, click row → navigates to Logs
3. Rules → table, URL tester, add rule modal, edit modal
4. Logs → filters, split view, detail panel, Create Rule → SmartRuleBuilder modal
5. Approvals → pending list, countdown, approve/reject/approve+create rule
6. Theme switcher → light/dark/system all work
7. Logout → returns to login

- [ ] **Step 4: Fix any visual issues found in QA**

- [ ] **Step 5: Final commit**

```bash
git add -A gui/
git commit -m "feat(gui): complete admin panel redesign with theming and smart rule builder"
```
