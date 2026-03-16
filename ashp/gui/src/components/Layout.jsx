import { NavLink, Outlet } from 'react-router-dom';

export default function Layout({ onLogout }) {
  return (
    <div className="layout">
      <nav>
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/rules">Rules</NavLink>
        <NavLink to="/logs">Logs</NavLink>
        <NavLink to="/approvals">Approvals</NavLink>
        <button onClick={onLogout}>Logout</button>
      </nav>
      <main><Outlet /></main>
    </div>
  );
}
