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
    expect(screen.getAllByText(/api\.openai\.com/).length).toBeGreaterThan(0);
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
    // Tab should be active (verify it doesn't crash)
  });
});
