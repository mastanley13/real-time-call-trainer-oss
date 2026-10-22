"use client";

import * as React from "react";
import { createContext, useContext, useState, useEffect } from "react";

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  password: string;
  /** Exactly one of these two is supplied. */
  joinOrgCode?: string;
  newOrgName?: string;
}

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role?: "trainee" | "manager" | "owner" | "admin";
}

export interface Capabilities {
  demoMode: boolean;
  elevenlabs: boolean;
  llm: boolean;
  database: boolean;
}

export interface MfaChallenge {
  challengeToken: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  login: (credentials: LoginCredentials) => Promise<MfaChallenge | null>;
  completeMfaChallenge: (
    challengeToken: string,
    code: string,
  ) => Promise<void>;
  register: (formData: RegisterFormData) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
  isAuthenticated: boolean;
  capabilities: Capabilities | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Decode a JWT payload for display/restoration purposes only. The server is
 * the single source of truth for verification — this function must never be
 * used for authorization decisions.
 */
const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return JSON.parse(atob(b64 + pad));
  } catch {
    return null;
  }
};

const isTokenFresh = (token: string | null): boolean => {
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return false;
  const exp = (payload as { exp?: number }).exp;
  return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  useEffect(() => {
    setIsLoading(true);
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((caps: Capabilities | null) => {
        setCapabilities(caps);
        if (caps?.demoMode) {
          setUser({ id: "demo-user", email: "demo@example.local", firstName: "Demo", lastName: "User", role: "owner" });
          setIsAuthenticated(true);
        }
      })
      .catch(() => setCapabilities({ demoMode: false, elevenlabs: false, llm: false, database: true }));
    try {
      const token = localStorage.getItem("authToken");
      const storedUser = localStorage.getItem("userData");

      if (token && storedUser && isTokenFresh(token)) {
        const parsedUser: User = JSON.parse(storedUser);
        setUser(parsedUser);
        setIsAuthenticated(true);
      } else {
        localStorage.removeItem("authToken");
        localStorage.removeItem("userData");
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error("[AuthContext] init error:", error);
      localStorage.removeItem("authToken");
      localStorage.removeItem("userData");
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const persistSession = (sessionUser: User, token: string) => {
    localStorage.setItem("authToken", token);
    localStorage.setItem("userData", JSON.stringify(sessionUser));
    setUser(sessionUser);
    setIsAuthenticated(true);
  };

  const clearSession = () => {
    localStorage.removeItem("authToken");
    localStorage.removeItem("userData");
    setUser(null);
    setIsAuthenticated(false);
  };

  const login = async (
    credentials: LoginCredentials,
  ): Promise<MfaChallenge | null> => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(credentials),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Login failed");
      }
      const data = await response.json();
      if (data.mfaRequired && data.challengeToken) {
        return { challengeToken: data.challengeToken, email: credentials.email };
      }
      persistSession(data.user, data.token);
      return null;
    } catch (error) {
      clearSession();
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const completeMfaChallenge = async (
    challengeToken: string,
    code: string,
  ) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/mfa/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ challengeToken, code }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "MFA challenge failed");
      }
      const { user: sessionUser, token } = await response.json();
      persistSession(sessionUser, token);
    } catch (error) {
      clearSession();
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (formData: RegisterFormData) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(formData),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Registration failed");
      }
      const { user: sessionUser, token } = await response.json();
      persistSession(sessionUser, token);
    } catch (error) {
      clearSession();
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    setIsLoading(true);
    clearSession();
    fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(
      () => {},
    );
    setIsLoading(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        completeMfaChallenge,
        register,
        logout,
        isLoading,
        isAuthenticated,
        capabilities,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
