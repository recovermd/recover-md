/** Small presentational primitives shared across the app. */
import React from 'react';

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

export function Button({
  children,
  variant = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
}): React.JSX.Element {
  const base =
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const styles = {
    default: 'border border-edge bg-panel text-ink hover:bg-edge/40',
    primary: 'bg-accent text-[rgb(var(--rmd-on-accent))] hover:opacity-90',
    ghost: 'text-muted hover:text-ink hover:bg-panel',
    danger:
      'border border-edge text-[rgb(var(--rmd-removed-ink))] hover:bg-[rgb(var(--rmd-removed-bg))]'
  }[variant];
  return (
    <button className={cx(base, styles, className)} {...props}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex rounded-full border border-edge bg-surface p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          title={option.title}
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors',
            value === option.value ? 'bg-accent text-[rgb(var(--rmd-on-accent))]' : 'text-muted hover:text-ink'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      <p className="font-display max-w-md text-[22px] font-medium leading-snug tracking-tight text-ink">{title}</p>
      {description ? (
        <p className="max-w-sm text-[13px] leading-relaxed text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'negative' | 'accent';
}): React.JSX.Element {
  const styles = {
    neutral: 'border-edge text-muted',
    positive: 'border-transparent bg-[rgb(var(--rmd-added-bg))] text-[rgb(var(--rmd-added-ink))]',
    negative: 'border-transparent bg-[rgb(var(--rmd-removed-bg))] text-[rgb(var(--rmd-removed-ink))]',
    accent: 'border-transparent bg-accent/15 text-accent'
  }[tone];
  return (
    <span className={cx('rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wide', styles)}>
      {children}
    </span>
  );
}

export function Modal({
  title,
  children,
  onClose,
  footer
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-edge bg-surface">
        <header className="border-b border-edge px-5 py-3.5">
          <h2 className="font-display text-[18px] font-medium tracking-tight">{title}</h2>
        </header>
        <div className="px-5 py-4 text-[13px] leading-relaxed text-ink">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-edge px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * Minimal windowed list. Large diffs and long timelines must not render every row (FR-6),
 * and a hand-rolled window keeps the dependency surface at zero.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  height,
  renderRow,
  overscan = 12,
  className
}: {
  items: readonly T[];
  rowHeight: number;
  height: number;
  renderRow: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  className?: string;
}): React.JSX.Element {
  const [scrollTop, setScrollTop] = React.useState(0);
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, start + visibleCount);
  const slice = items.slice(start, end);

  return (
    <div
      className={cx('relative overflow-auto', className)}
      style={{ height }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
          {slice.map((item, index) => renderRow(item, start + index))}
        </div>
      </div>
    </div>
  );
}

/** Measures its container so virtualized children get a concrete pixel height. */
export function AutoHeight({
  children,
  className
}: {
  children: (height: number) => React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(400);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={cx('h-full w-full', className)}>
      {children(height)}
    </div>
  );
}
