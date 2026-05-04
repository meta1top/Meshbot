export interface ApiResponse<T = unknown> {
  data: T;
  message?: string;
}

export interface PaginatedRequest {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
