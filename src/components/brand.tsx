export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="avx-silver" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F3F4F6" />
          <stop offset="1" stopColor="#8B95A5" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#141A23" stroke="#303A49" />
      <path d="M8 23 L16 8 L24 23" fill="none" stroke="url(#avx-silver)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 18.5 L15 21.5 L21 15" fill="none" stroke="#2563EB" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <Logo />
      <div className="leading-tight">
        <div className="metal-text text-base font-semibold tracking-tight">AvixCheck</div>
        <div className="text-[11px] text-muted">Every invoice. Checked.</div>
      </div>
    </div>
  );
}
