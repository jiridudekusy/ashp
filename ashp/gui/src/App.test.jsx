import { render, screen } from '@testing-library/react';
import App from './App';

test('shows login page initially', () => {
  render(<App />);
  expect(screen.getByPlaceholderText('Enter your bearer token')).toBeInTheDocument();
});
