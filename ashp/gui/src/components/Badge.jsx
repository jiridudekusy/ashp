import styles from './Badge.module.css';

const VARIANTS = {
  allow: styles.allow, allowed: styles.allow,
  deny: styles.deny, denied: styles.deny,
  hold: styles.hold, held: styles.hold,
};

export function Badge({ variant, children }) {
  const cls = VARIANTS[variant] || '';
  return <span className={`${styles.badge} ${cls}`}>{children || variant}</span>;
}
