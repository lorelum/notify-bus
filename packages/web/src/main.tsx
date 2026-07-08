import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import "./index.css";
import { Dashboard, RoutesPage, ChannelsPage, TemplatesPage, LogsPage } from "./pages";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/routes", label: "Routes" },
  { to: "/channels", label: "Channels" },
  { to: "/templates", label: "Templates" },
  { to: "/logs", label: "Logs" },
];

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header className="border-b border-gray-200 dark:border-gray-800">
        <nav className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-6">
          <span className="font-bold text-lg">🚌 notify-bus</span>
          <div className="flex gap-4">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `text-sm ${isActive ? "text-blue-600 font-semibold" : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <StrictMode>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/routes" element={<RoutesPage />} />
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/logs" element={<LogsPage />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </StrictMode>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
