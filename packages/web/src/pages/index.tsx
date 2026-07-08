/**
 * Route placeholder pages. Real implementations land in M4–M6.
 * Each page is a stub showing the intended content area.
 */
import type { ReactNode } from "react";

function PageShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">{title}</h1>
      {subtitle && <p className="text-gray-500 dark:text-gray-400 mb-6">{subtitle}</p>}
      {children}
    </div>
  );
}

function ComingSoon({ milestone }: { milestone: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-12 text-center text-gray-400">
      <p className="text-lg">🚧 Under construction</p>
      <p className="text-sm mt-2">Lands in <span className="font-mono font-semibold">{milestone}</span></p>
    </div>
  );
}

export function Dashboard() {
  return (
    <PageShell title="Dashboard" subtitle="Service status and recent activity">
      <ComingSoon milestone="M4" />
    </PageShell>
  );
}

export function RoutesPage() {
  return (
    <PageShell title="Routes" subtitle="Match conditions → target channels">
      <ComingSoon milestone="M4" />
    </PageShell>
  );
}

export function ChannelsPage() {
  return (
    <PageShell title="Channels" subtitle="Webhook destinations (Feishu, and more)">
      <ComingSoon milestone="M5" />
    </PageShell>
  );
}

export function TemplatesPage() {
  return (
    <PageShell title="Templates" subtitle="Handlebars templates per event type">
      <ComingSoon milestone="M5" />
    </PageShell>
  );
}

export function LogsPage() {
  return (
    <PageShell title="Logs" subtitle="Recent webhook processing results">
      <ComingSoon milestone="M6" />
    </PageShell>
  );
}
