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
