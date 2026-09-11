import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

/** What a notice says: `headline` names the thing, `status` says what happened to it. */
export type ToastItem = {
  id: string;
  headline: string;
  status: string;
  /** `ok` is green — success, in a notice. `pending` is amber: the chain has said so, the worker has not yet. */
  tone: 'ok' | 'pending';
  /** A qualifier on the status: "confirming". */
  note?: string;
  meta?: ReactNode;
  action: { label: string; href: string };
  /** Arrived while the tab was open. Only these pulse; a notice found on load is old news. */
  fresh?: boolean;
};

type Props = {
  /** Newest first: the front of the stack is the most recent. */
  items: ToastItem[];
  onOpen: (item: ToastItem) => void;
  onDismiss: (item: ToastItem) => void;
  onDismissAll?: () => void;
  /** In the page flow rather than fixed at the corner — for the design-system specimen. */
  inline?: boolean;
};

/** Collapsed: each card behind the front one peeks out by this much. Expanded: the gap between cards. */
const PEEK = 12, GAP = 10, VISIBLE = 3, EXIT_MS = 220;
/** A drag past this, or a flick faster than this (px/ms), dismisses. */
const SWIPE_PX = 48, SWIPE_VELOCITY = 0.11;

/**
 * A stack of notices at the corner of the viewport. Collapsed, the newest sits in front with the
 * others tucked behind it; hovering (or, on touch, tapping) fans them out. Each card slides up
 * from the edge when it arrives and drops back out when dismissed — the same direction both
 * ways, which is what makes swiping one down feel obvious. Nothing here times out: a notice is a
 * record, and it leaves when the reader says so.
 *
 * Every card is positioned from measured heights, so the layout is transforms only and the
 * fan-out is one interruptible transition: a card mid-flight retargets, it never restarts.
 */
export function Toasts({ items, onOpen, onDismiss, onDismissAll, inline }: Props) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);
  const [leaving, setLeaving] = useState<Map<string, { item: ToastItem; y: number }>>(new Map());
  const lastY = useRef(new Map<string, number>());
  const region = useRef<HTMLDivElement>(null);

  // A dismissed card stays for its exit, at the offset it had, while the ones behind it move up.
  const previous = useRef<ToastItem[]>([]);
  useEffect(() => {
    const present = new Set(items.map(item => item.id));
    const gone = previous.current.filter(item => !present.has(item.id));
    previous.current = items;
    if (gone.length === 0) return;
    setLeaving(current => {
      const next = new Map(current);
      for (const item of gone) next.set(item.id, { item, y: lastY.current.get(item.id) ?? 0 });
      return next;
    });
    const timer = window.setTimeout(() => setLeaving(current => {
      const next = new Map(current);
      for (const item of gone) next.delete(item.id);
      return next;
    }), EXIT_MS + 40);
    return () => window.clearTimeout(timer);
  }, [items]);

  // Touch has no hover: a tap on the stack fans it out, a tap anywhere else folds it.
  useEffect(() => {
    if (!expanded) return;
    const away = (event: PointerEvent) => { if (!region.current?.contains(event.target as Node)) setExpanded(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [expanded]);

  const open = expanded && items.length > 1;
  const front = items[0] ? heights[items[0].id] ?? 0 : 0;
  const offsets: number[] = [];
  let y = 0;
  items.forEach((item, index) => {
    // Collapsed, a card's top edge shows PEEK above the one in front of it, whatever their heights.
    const depth = Math.min(index, VISIBLE), scale = 1 - depth * .05;
    offsets.push(open ? y : front - scale * (heights[item.id] ?? 0) + depth * PEEK);
    y += (heights[item.id] ?? 0) + GAP;
    lastY.current.set(item.id, offsets[index]!);
  });
  const height = items.length === 0 ? 0 : open ? y - GAP : front + Math.min(items.length - 1, VISIBLE - 1) * PEEK;
  const ghosts = [...leaving.values()].filter(ghost => !items.some(item => item.id === ghost.item.id));

  return (
    <div ref={region} className={`toasts${inline ? ' inline' : ''}${open ? ' open' : ''}`} role="status" aria-live="polite"
      style={{ height }}
      onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setExpanded(false); }}
      onPointerDown={event => { if (event.pointerType === 'touch') setExpanded(true); }}>
      {open && onDismissAll && (
        <div className="toasts-head" style={{ bottom: height + GAP }}>
          <span className="small muted">{items.length} notices</span>
          <button className="link small" onClick={onDismissAll}>Dismiss all</button>
        </div>
      )}
      {items.map((item, index) => (
        <ToastCard key={item.id} item={item} y={offsets[index]!} scale={open ? 1 : 1 - Math.min(index, VISIBLE) * .05}
          hidden={!open && index >= VISIBLE} z={items.length - index} stagger={index * 40} swipeable={open || index === 0}
          onOpen={() => onOpen(item)} onDismiss={() => onDismiss(item)}
          onHeight={value => setHeights(current => current[item.id] === value ? current : { ...current, [item.id]: value })} />
      ))}
      {ghosts.map(ghost => (
        <ToastCard key={ghost.item.id} item={ghost.item} y={ghost.y} scale={1} z={0} leaving onOpen={() => undefined} onDismiss={() => undefined} onHeight={() => undefined} />
      ))}
    </div>
  );
}

type CardProps = {
  item: ToastItem; y: number; scale: number; z: number;
  hidden?: boolean; leaving?: boolean; stagger?: number; swipeable?: boolean;
  onOpen: () => void; onDismiss: () => void; onHeight: (height: number) => void;
};

function ToastCard({ item, y, scale, z, hidden, leaving, stagger = 0, swipeable, onOpen, onDismiss, onHeight }: CardProps) {
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'entering' | 'shown'>('entering');
  const [drag, setDrag] = useState<{ dy: number; active: boolean }>({ dy: 0, active: false });
  // The pointer's travel, read at release from the ref: a flick can end before React has re-rendered.
  const start = useRef<{ y: number; at: number; dy: number } | null>(null);

  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    onHeight(node.offsetHeight);
    const observer = new ResizeObserver(() => onHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount below the edge, then let the transition carry the card to its slot. Cards found on
  // load arrive one after another; a live one is alone and comes at once.
  useEffect(() => {
    if (leaving) return;
    const timer = window.setTimeout(() => setState('shown'), item.fresh ? 0 : stagger);
    return () => window.clearTimeout(timer);
  }, [leaving, item.fresh, stagger]);

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!swipeable || leaving || (event.target as HTMLElement).closest('a, button')) return;
    try { (event.target as HTMLElement).setPointerCapture(event.pointerId); } catch { /* a pointer that has already gone */ }
    start.current = { y: event.clientY, at: performance.now(), dy: 0 };
    setDrag({ dy: 0, active: true });
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const travel = event.clientY - start.current.y;
    // Up is the wrong way: it moves, but with friction, so the card feels held rather than walled.
    start.current.dy = travel < 0 ? travel / 4 : travel;
    setDrag({ dy: start.current.dy, active: true });
  };
  const up = () => {
    if (!start.current) return;
    const { dy, at } = start.current;
    start.current = null;
    if (dy >= SWIPE_PX || (dy > 0 && dy / (performance.now() - at) > SWIPE_VELOCITY)) onDismiss();
    setDrag({ dy: 0, active: false });
  };

  const style = {
    '--y': `${-y + drag.dy}px`, '--s': scale, zIndex: z,
    // A card being dragged out fades as it goes, so the release is not a jump.
    opacity: drag.active && drag.dy > 0 ? Math.max(0, 1 - drag.dy / 160) : undefined,
  } as CSSProperties;

  return (
    <div ref={element} className={`toast ${item.tone}${item.fresh ? ' fresh' : ''}`} style={style}
      data-state={leaving ? 'leaving' : state} data-hidden={hidden || undefined} data-dragging={drag.active || undefined}
      aria-hidden={hidden || leaving || undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="toast-eyebrow">
        <span className="toast-dot" aria-hidden="true" />
        <span className="toast-status">{item.status}</span>
        {item.note && <span className="toast-note">{item.note}</span>}
        <button className="toast-close" aria-label="Dismiss" onClick={onDismiss} tabIndex={hidden ? -1 : 0}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <p className="toast-headline">{item.headline}</p>
      <div className="toast-foot">
        {item.meta ? <span className="toast-meta">{item.meta}</span> : <span />}
        <a className="button primary toast-action" href={item.action.href} tabIndex={hidden ? -1 : 0}
          onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onOpen(); }}>
          {item.action.label}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7m-3-3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
        </a>
      </div>
    </div>
  );
}
