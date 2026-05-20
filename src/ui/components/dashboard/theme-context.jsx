"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const DEFAULT_THEME = {
  backgroundColor: "#e0f2fe",
  surfaceColor: "#f8fafc",
  primaryColor: "#2563eb",
  accentColor: "#0ea5e9",
  textColor: "#0f172a",
  mutedTextColor: "#475569",
  logoDataUrl: null,
};

const LEGACY_DEFAULT_THEME = {
  backgroundColor: "#f1f5f9",
  surfaceColor: "#ffffff",
  primaryColor: "#2563eb",
  accentColor: "#0f172a",
  textColor: "#0f172a",
  mutedTextColor: "#64748b",
  logoDataUrl: null,
};

const STORAGE_KEY = "dashboard-theme-settings";

function isLegacyDefaultTheme(theme) {
  return Object.entries(LEGACY_DEFAULT_THEME).every(([key, value]) => theme?.[key] === value);
}

const DashboardThemeContext = createContext({
  theme: DEFAULT_THEME,
  updateTheme: () => {},
  resetTheme: () => {},
});

export function DashboardThemeProvider({ children }) {
  const [theme, setTheme] = useState(DEFAULT_THEME);

  useEffect(() => {
    try {
      const storedValue = localStorage.getItem(STORAGE_KEY);
      if (!storedValue) {
        return;
      }

      const parsedValue = JSON.parse(storedValue);
      if (parsedValue && typeof parsedValue === "object") {
        if (isLegacyDefaultTheme(parsedValue)) {
          return;
        }

        setTheme((previous) => ({ ...previous, ...parsedValue }));
      }
    } catch (error) {
      console.warn("Failed to restore dashboard theme", error);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    } catch (error) {
      console.warn("Failed to persist dashboard theme", error);
    }
  }, [theme]);

  const updateTheme = useCallback((updates) => {
    setTheme((previous) => ({ ...previous, ...updates }));
  }, []);

  const resetTheme = useCallback(() => {
    setTheme(DEFAULT_THEME);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      updateTheme,
      resetTheme,
    }),
    [theme, updateTheme, resetTheme],
  );

  return <DashboardThemeContext.Provider value={value}>{children}</DashboardThemeContext.Provider>;
}

export function useDashboardTheme() {
  const context = useContext(DashboardThemeContext);

  if (!context) {
    throw new Error("useDashboardTheme must be used within a DashboardThemeProvider");
  }

  return context;
}

export { DEFAULT_THEME };
