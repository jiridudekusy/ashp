# ASHP GUI Redesign — Design Spec

## Overview

Complete visual and UX redesign of the ASHP admin GUI. The current GUI has no CSS and minimal UX — this redesign replaces it with a clean admin panel styled after Stripe Dashboard, with a key new feature: smart rule creation from any request detail.

**Scope:** Desktop-only. No responsive/mobile layout — this is an admin tool typically used on a desktop or laptop.

## Visual Foundation

### Layout
- **Top navigation bar** — horizontal, full-width
  - Left: ASHP logo/brand
  - Center: page tabs (Dashboard, Rules, Logs, Approvals)
  - Approvals tab shows red badge with pending count
  - Right: proxy connection status indicator (green dot + "Proxy connected"), theme switcher, **Logout button**
- **Content area** — light grey background (#f8fafc), white card containers

### Color Palette — Light Theme
- **Accent:** Blue (#3b82f6) for primary actions, active states, links
- **Status colors:**
  - Allow: green (#16a34a), background (#dcfce7)
  - Deny: red (#dc2626), background (#fef2f2)
  - Hold: amber (#d97706), background (#fef3c7)
- **Neutrals:** Slate scale (#0f172a text, #64748b secondary, #94a3b8 muted, #e2e8f0 borders)
- **Background:** #f8fafc page, #ffffff cards

### Color Palette — Dark Theme
- **Accent:** Blue (#60a5fa) — lighter shade for dark backgrounds
- **Status colors:** Same hues, slightly adjusted for dark contrast:
  - Allow: #4ade80, background (#052e16)
  - Deny: #f87171, background (#450a0a)
  - Hold: #fbbf24, background (#451a03)
- **Neutrals:** Inverted slate (#f1f5f9 text, #94a3b8 secondary, #64748b muted, #334155 borders)
- **Background:** #0f172a page, #1e293b cards

### Theme Support
- Three modes: **Light** (default), **Dark**, **System** (follows OS preference via `prefers-color-scheme`)
- Implemented via CSS custom properties (variables) on `:root` / `[data-theme="dark"]`
- Theme preference stored in `localStorage`
- Theme switcher in the top nav bar
- All components must respect the active theme — including code/body viewers

## Pages

### Login
- Preserves existing auth flow: user enters a bearer token, validated against `GET /api/status`
- Token stored in `sessionStorage` (existing behavior)
- Clean centered card with token input field + "Login" button
- Error message on invalid token
- On success, redirects to Dashboard

### Dashboard
- **Status cards row** (4 cards):
  - Proxy Status — connected/disconnected indicator, uptime
  - Active Rules — count (from `GET /api/status` `rules_count`)
  - Pending Approvals — count, clickable link to Approvals page
  - Default Behavior — current setting (from server config, shown as allow/deny/hold badge)
- **Live Activity feed** — table-like list of recent requests
  - Populated from `GET /api/logs?limit=20` on load
  - Columns: decision badge (allow/deny/hold), method + URL, status/response info, relative timestamp
  - Hold entries highlighted with amber background
  - Real-time SSE updates — new entries prepended at top
  - Each row clickable → navigates to Logs page with that entry selected

### Rules
- **Header row** — page title, rule count, inline URL tester, "+ Add Rule" button
- **Inline URL tester** — input field + method dropdown + "Test" button. Result shows as a banner below the table indicating matched rule and resulting action.
- **Rules table** — columns: name, pattern (monospace), method badge, action badge (colored), priority, enabled status (green/grey dot), edit/delete actions
  - Disabled rules shown at reduced opacity
  - Sorted by priority
- **"+ Add Rule"** opens the Rule Form modal (full form with all fields)
- **"Edit"** opens the Rule Form modal pre-filled with existing rule values
- **Read-only mode:** When rules source is `file` (from `GET /api/status` `rules_source`), hide "+ Add Rule" button, disable "Edit"/"Delete" actions, show info banner: "Rules are managed via config file. Editing is disabled."

### Logs
- **Split view** — log list on the left, detail panel on the right
- **Filter bar** at top of list:
  - Decision toggle: All / Allow / Deny / Hold (segmented button)
  - Method toggle: All / GET / POST / PUT / DEL (segmented button)
  - URL text filter input
- **Log list** — compact rows with: decision badge, method, URL (truncated), timestamp
  - Selected row highlighted with blue left border + blue background
- **Pagination** at bottom of list — 50 items per page (existing default), prev/next buttons, total count display
- **Detail panel** — see Shared Components below
- **SSE updates:** "New entries available" clickable banner appears at top of list when new log entries arrive while browsing. Click to refresh.

### Approvals
- **Split view** — same layout as Logs
- **Pending section** at top of list:
  - Each item shows: method + URL, waiting time, timeout progress bar (live countdown)
  - Sorted oldest first
- **Recently Resolved section** below:
  - Tracked client-side via SSE `approval.resolved` events during the session
  - Faded (reduced opacity), shows approved/rejected badge + relative timestamp
  - Cleared on page refresh (not persisted — these are for in-session reference only)
- **Detail panel** — same shared component as Logs, plus:
  - Timeout countdown with progress bar
  - Three action buttons at bottom:
    - **Approve** (green) — calls `resolveApproval(id, { action: 'approve' })`
    - **Reject** (red) — calls `resolveApproval(id, { action: 'reject' })`
    - **Approve + Create Rule** (blue) — calls `resolveApproval(id, { action: 'approve' })`, then on success opens Smart Rule Builder modal pre-filled from the request

## Shared Components

### Top Navigation
- Consistent across all pages
- Active page indicated by blue bottom border on tab
- Pending approval count badge on Approvals tab (red, updates via SSE)
- Proxy status indicator on the right
- Theme switcher (light/dark/system icon toggle)
- Logout button (rightmost)

### Detail Panel
- Reusable component used in: Logs, Approvals
- **Header:** method + full URL, decision badge, timestamp
- **Info tab:** URL, method, matched rule, reason, response status, duration
- **Request Body tab:** full request body with syntax highlighting, respects theme
- **Response Body tab:** full response body with syntax highlighting, respects theme
- Tabs take up full available vertical space for body content
- Body syntax highlighting: simple custom JSON highlighter (no external library). For non-JSON content, render as plain monospace text.
- **"Create Rule from Request"** button at the bottom — present on ALL detail panels regardless of which page

### Smart Rule Builder Modal
- Triggered from: detail panel "Create Rule" button, approval "Approve + Create Rule" button
- **Modal overlay** with centered dialog
- **Content:**
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
- Pattern suggestions are generated client-side by splitting the URL at path segments
- Calls `createRule()` API on submit

### Rule Form Modal
- Triggered from: Rules page "+ Add Rule" / "Edit"
- Full form with all rule fields:
  - **Name** (text input)
  - **URL Pattern** (text input)
  - **Methods** (multi-select or text: GET, POST, PUT, DELETE, ALL)
  - **Action** (dropdown: allow / deny / hold)
  - **Priority** (number input)
  - **Enabled** (toggle)
  - **Log Request Body** (toggle)
  - **Log Response Body** (toggle)
- Pre-filled when editing an existing rule
- Calls `createRule()` or `updateRule()` API on submit

## Real-time Updates (SSE)
- Dashboard activity feed — new entries prepended
- Approvals page — new pending items appear, resolved items tracked in "Recently Resolved"
- Approval badge count in nav — updates on `approval.needed` / `approval.resolved` events
- Logs page — "New entries available" banner on new events, click to refresh

## Error States
- **API errors:** Toast/banner notification at top of content area (auto-dismiss after 5s)
- **SSE disconnection:** Orange "Reconnecting..." indicator replaces green "Proxy connected" in nav
- **Empty states:** Friendly message for each page when no data (e.g., "No pending approvals", "No log entries yet", "No rules configured")
- **Loading states:** Skeleton placeholders while data loads

## Technology
- React 19 + React Router 7 (existing)
- **CSS approach:** CSS Modules (`.module.css` co-located with each component) + shared `theme/variables.css` for CSS custom properties (theming, colors, spacing). Vite supports CSS Modules natively — zero config.
- No external UI library — hand-crafted components matching the design spec
- Vite for bundling (existing)
