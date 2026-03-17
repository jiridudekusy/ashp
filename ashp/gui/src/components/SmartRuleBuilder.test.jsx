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
