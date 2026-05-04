import axios, {
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

const TOKEN_KEY = "anybot_access_token";

function resolveBaseURL(): string {
  if (typeof window === "undefined") {
    return "http://localhost:3100";
  }
  const { hostname } = window.location;
  return `http://${hostname}:3100`;
}

export function createApiClient(baseURL?: string): AxiosInstance {
  const client = axios.create({
    baseURL: baseURL ?? resolveBaseURL(),
    timeout: 30000,
    headers: { "Content-Type": "application/json" },
  });

  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    if (typeof window !== "undefined") {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        if (typeof window !== "undefined") {
          localStorage.removeItem(TOKEN_KEY);
          const currentPath = window.location.pathname;
          if (currentPath !== "/login" && currentPath !== "/setup") {
            window.location.href = "/login";
          }
        }
      }
      return Promise.reject(error);
    },
  );

  return client;
}

export const apiClient = createApiClient();

export function setAccessToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
