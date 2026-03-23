/**
 * @file Theme management hook — cycles between light, dark, and system modes.
 *
 * Persists the user's choice in localStorage. In 'system' mode, listens
 * to the prefers-color-scheme media query and updates the data-theme
 * attribute on <html> reactively. CSS variables in variables.css respond
 * to data-theme to apply the correct palette.
 */
import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'ashp-theme';
const CYCLE = ['light', 'dark', 'system'];

/** Sets the data-theme attribute on the root element, resolving 'system' to actual preference. */
function applyTheme(theme) {
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

/**
 * @returns {{ theme: string, setTheme: Function, cycleTheme: Function }}
 *   theme - Current mode ('light'|'dark'|'system')
 *   setTheme - Set a specific mode
 *   cycleTheme - Advance to the next mode in the cycle
 */
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
