'use client';

// ABOUTME: Top-bar light/dark toggle. Flips `data-theme` on <html> and persists the choice.
// ABOUTME: Which icon shows is decided purely in CSS (sun in dark, moon in light), so there is no
// ABOUTME: theme-dependent render on the server and therefore no hydration mismatch.

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('mc-theme', next);
  } catch {
    /* storage may be unavailable (private mode); the toggle still works for this session */
  }
}

export function ThemeToggle() {
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={toggleTheme}
      aria-label="Toggle color theme"
      title="Toggle light / dark"
    >
      {/* sun — shown in dark mode */}
      <svg
        className="ic-sun"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
      {/* moon — shown in light mode */}
      <svg
        className="ic-moon"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
