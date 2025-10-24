import type { AuthProvider } from "@workflow/world";

export const auth: AuthProvider = {
  async getAuthInfo() {
    return {
      ownerId: "restate-owner",
      projectId: "restate-project",
      environment: "restate",
      userId: "restate-user",
    };
  },

  async checkHealth() {
    return {
      success: true,
      data: { healthy: true },
      message: "backend is healthy",
    };
  },
};
