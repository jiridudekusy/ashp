# ASHP GUI Redesign — Design Spec

## Overview

Complete visual and UX redesign of the ASHP admin GUI. The current GUI has no CSS and minimal UX — this redesign replaces it with a clean admin panel styled after Stripe Dashboard, with a key new feature: smart rule creation from any request detail.

## Visual Foundation

### Layout
- **Top navigation bar** — horizontal, full-width
  - Left: ASHP logo/brand
  - Center: page tabs (Dashboard, Rules, Logs, Approvals)
  - Approvals tab shows red badge with pending count
  - Right: proxy connection status indicator (green dot + "Proxy connected"), theme switcher
- **Content area** — light grey background (#f8fafc), white card containers

### Color Palette
- **Accent:** Blue (#3b82f6) for primary actions, active states, links
- **Status colors:**
  - Allow: green (#16a34a), background (#dcfce7)
  - Deny: red (#dc2626), background (#fef2f2)
  - Hold: amber (#d97706), background (#fef3c7)
- **Neutrals:** Slate scale (#0f172a text, #64748b secondary, #94a3b8 muted, #e2e8f0 borders)
- **Background:** #f8fafc page, #ffffff cards

### Theme Support
- Three modes: **Light** (default), **Dark**, **System** (follows OS preference via `prefers-color-scheme`)
- Theme switcher in the top nav bar
- All components must respect the active theme — including code/body viewers

## Pages

### Dashboard
- **Status cards row** (4 cards):
  - Proxy Status — connected/disconnected indicator, uptime
  - Active Rules — count, breakdown by action (allow/deny/hold)
  - Pending Approvals — count, clickable link to Approvals page
  - Default Behavior — current setting (allow/deny/hold)
- **Live Activity feed** — table-like list of recent requests
  - Columns: decision badge (allow/deny/hold), method + URL, status/response info, relative timestamp
  - Hold entries highlighted with amber background
  - Real-time SSE updates — new entries appear at top
  - Each row clickable → opens detail (shared detail panel component)

### Rules
- **Header row** — page title, rule count, inline URL tester, "+ Add Rule" button
- **Inline URL tester** — input field + method dropdown + "Test" button. Result shows as a banner below the table indicating matched rule and resulting action.
- **Rules table** — columns: priority number, pattern (monospace), method badge, action badge (colored), priority value, enabled status (green/grey dot), edit/delete actions
  - Disabled rules shown at reduced opacity
  - Sorted by priority
- **"+ Add Rule"** opens the Smart Rule Builder modal (without pre-filled URL)
- **"Edit"** opens the Smart Rule Builder modal pre-filled with existing rule values

### Logs
- **Split view** — log list on the left, detail panel on the right
- **Filter bar** at top of list:
  - Decision toggle: All / Allow / Deny / Hold (segmented button)
  - Method toggle: All / GET / POST / PUT / DEL (segmented button)
  - URL text filter input
- **Log list** — compact rows with: decision badge, method, URL (truncated), timestamp
  - Selected row highlighted with blue left border + blue background
- **Pagination** at bottom of list (items per page, prev/next)
- **Detail panel** — see Shared Components below

### Approvals
- **Split view** — same layout as Logs
- **Pending section** at top of list:
  - Each item shows: method + URL, waiting time, timeout progress bar (live countdown)
  - Sorted oldest first
- **Recently Resolved section** below:
  - Faded (reduced opacity), shows approved/rejected badge + timestamp
  - For reference only
- **Detail panel** — same shared component as Logs, plus:
  - Timeout countdown with progress bar
  - Three action buttons at bottom:
    - **Approve** (green) — approves the held request
    - **Reject** (red) — rejects the held request
    - **Approve + Create Rule** (blue) — approves and opens Smart Rule Builder modal

## Shared Components

### Top Navigation
- Consistent across all pages
- Active page indicated by blue bottom border on tab
- Pending approval count badge on Approvals tab (red, updates via SSE)
- Proxy status indicator on the right
- Theme switcher (light/dark/system)

### Detail Panel
- Reusable component used in: Dashboard (on row click), Logs, Approvals
- **Header:** method + full URL, decision badge, timestamp
- **Info tab:** URL, method, matched rule, reason, response status, duration
- **Request Body tab:** full request body with syntax highlighting, respects theme
- **Response Body tab:** full response body with syntax highlighting, respects theme
- Tabs take up full available vertical space for body content
- **"Create Rule from Request"** button at the bottom — present on ALL detail panels regardless of which page

### Smart Rule Builder Modal
- Triggered from: detail panel "Create Rule" button, approval "Approve + Create Rule" button, Rules page "+ Add Rule" / "Edit"
- **Modal overlay** with centered dialog
- **Content when created from a request:**
  - Source request summary (method + URL + decision) at top
  - **Pattern scope selector** — list of suggested patterns from specific to broad:
    - Exact URL: `api.openai.com/v1/chat/completions`
    - Path wildcard: `api.openai.com/v1/chat/*`
    - API wildcard: `api.openai.com/v1/*`
    - Domain wildcard: `api.openai.com/*`
  - Patterns are clickable rows (not a textbox), with scope labels (exact/path/api/domain)
  - Selected pattern highlighted in blue
  - **Method dropdown** — pre-filled from request, option for ALL
  - **Action dropdown** — allow / deny / hold
  - **Create Rule** button + Cancel
- **Content when creating manually (from Rules page):**
  - Same modal but pattern field is a text input (no suggestions available)
  - Method, action, priority, enabled toggle fields
- Pattern suggestions are generated client-side by splitting the URL at path segments

## Real-time Updates (SSE)
- Dashboard activity feed — new entries prepended
- Approvals page — new pending items appear, resolved items move to "Recently Resolved"
- Approval badge count in nav — updates on approval.needed / approval.resolved events
- Logs page — optional auto-refresh or "New entries available" banner

## Technology
- React 19 + React Router 7 (existing)
- CSS approach: CSS modules or a single global stylesheet with CSS custom properties for theming
- No external UI library — hand-crafted components matching the design spec
- Vite for bundling (existing)
