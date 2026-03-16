import { useState } from 'react';

const EMPTY = { name: '', url_pattern: '', methods: [], action: 'allow', priority: 0, enabled: true,
  log_request_body: 'full', log_response_body: 'full', default_behavior: '' };

export default function RuleForm({ rule, onSave, onCancel }) {
  const [form, setForm] = useState(rule || EMPTY);
  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <label>Name <input value={form.name} onChange={e => set('name', e.target.value)} required /></label>
      <label>URL Pattern <input value={form.url_pattern} onChange={e => set('url_pattern', e.target.value)} required /></label>
      <label>Methods (comma-sep) <input value={form.methods.join(',')}
        onChange={e => set('methods', e.target.value ? e.target.value.split(',').map(s => s.trim()) : [])} /></label>
      <label>Action
        <select value={form.action} onChange={e => set('action', e.target.value)}>
          <option value="allow">Allow</option><option value="deny">Deny</option>
        </select>
      </label>
      <label>Priority <input type="number" value={form.priority} onChange={e => set('priority', +e.target.value)} /></label>
      <label>Log Request Body
        <select value={form.log_request_body} onChange={e => set('log_request_body', e.target.value)}>
          <option value="full">Full</option><option value="none">None</option>
          <option value="truncate:65536">Truncate (64K)</option>
        </select>
      </label>
      <label>Log Response Body
        <select value={form.log_response_body} onChange={e => set('log_response_body', e.target.value)}>
          <option value="full">Full</option><option value="none">None</option>
          <option value="truncate:65536">Truncate (64K)</option>
        </select>
      </label>
      <label>Default Behavior Override
        <select value={form.default_behavior || ''} onChange={e => set('default_behavior', e.target.value || null)}>
          <option value="">(inherit global)</option>
          <option value="deny">Deny</option><option value="hold">Hold</option><option value="queue">Queue</option>
        </select>
      </label>
      <label><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled</label>
      <button type="submit">Save</button>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
    </form>
  );
}
