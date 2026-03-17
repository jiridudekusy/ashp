import styles from './JsonViewer.module.css';

export function JsonViewer({ text }) {
  if (!text) return <div className={styles.placeholder}>No content</div>;

  let formatted = text;
  try {
    const parsed = JSON.parse(text);
    formatted = JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON — render as plain text
    return <pre className={styles.code}>{text}</pre>;
  }

  // Simple regex-based syntax highlighting
  const highlighted = formatted
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"([^"]+)"(?=\s*:)/g, `<span class="${styles.key}">"$1"</span>`)
    .replace(/:\s*"([^"]*?)"/g, `: <span class="${styles.string}">"$1"</span>`)
    .replace(/:\s*(\d+\.?\d*)/g, `: <span class="${styles.number}">$1</span>`)
    .replace(/:\s*(true|false|null)/g, `: <span class="${styles.bool}">$1</span>`);

  return <pre className={styles.code} dangerouslySetInnerHTML={{ __html: highlighted }} />;
}
