// ABOUTME: The repeated chevron SVG, extracted into one component.

export function Chevron({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
