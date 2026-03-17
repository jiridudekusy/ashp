import { useState, useRef, useCallback, useEffect } from 'react';
import styles from './SplitPane.module.css';

const STORAGE_KEY = 'ashp-split-pane';

export function SplitPane({ left, right, storageId, defaultWidth = 380, minWidth = 250, maxWidth = 700 }) {
  const [width, setWidth] = useState(() => {
    if (storageId) {
      const saved = localStorage.getItem(`${STORAGE_KEY}:${storageId}`);
      if (saved) return Math.max(minWidth, Math.min(maxWidth, Number(saved)));
    }
    return defaultWidth;
  });
  const dragging = useRef(false);
  const containerRef = useRef(null);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = Math.max(minWidth, Math.min(maxWidth, rect.right - e.clientX));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (storageId) {
        localStorage.setItem(`${STORAGE_KEY}:${storageId}`, String(width));
      }
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [minWidth, maxWidth, storageId, width]);

  return (
    <div className={styles.container} ref={containerRef}>
      <div className={styles.left}>{left}</div>
      <div className={styles.divider} onMouseDown={onMouseDown}>
        <div className={styles.handle} />
      </div>
      <div className={styles.right} style={{ width }}>
        {right}
      </div>
    </div>
  );
}
